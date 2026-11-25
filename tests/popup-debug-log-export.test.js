// Debug-log JSON file export (issue #193): the DOM wiring of the real debug
// controller (popupDebug.js) driven through the real popup.js against the
// fake browser environment in tests/popup-harness.js, plus unit checks for
// the pure serializer in popupRules.js.
//
// The harness runs on Node 22, where `Blob` and `URL.createObjectURL` are
// real globals, so the export flow exercises the genuine download path —
// capturing `URL.createObjectURL` / `URL.revokeObjectURL` /
// `document.createElement('a')` without stubbing the Blob/URL machinery
// (same pattern as tests/popup-preset-export-import.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootPopup, flush, logMessages } from './popup-harness.js';
import {
  serializeDebugLogForExport,
  DEBUG_LOG_EXPORT_FILENAME,
} from '../QueryHop Extension/Resources/popupRules.js';

const FEEDBACK_DURATION = 1200;
const T1 = '2026-11-25T10:00:00.000Z';
const T2 = '2026-11-25T10:00:05.500Z';
const ENTRIES = [
  {
    event: 'redirect',
    engine: 'Google',
    query: 'n=12,fp=ab12cd34',
    targetUrl: 'https://search.brave.com/search?q=[REDACTED]',
    time: T1,
  },
  {
    event: 'blocked_scheme',
    targetUrl: 'javascript:[REDACTED:n=8,fp=deadbeef]',
    originalUrl: 'https://www.google.com/search?q=[REDACTED]',
    time: T2,
  },
];

// Capture the download machinery (Blob, object URL, revoked URL, <a> anchors
// and their click event) while `action` runs and settles, restoring globals
// unconditionally in finally.
async function captureDownload(state, action) {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalCreateElement = state.document.createElement;
  const blobs = [];
  const urls = [];
  const revoked = [];
  const anchors = [];
  const anchorClickEvents = [];

  URL.createObjectURL = (blob) => {
    blobs.push(blob);
    const url = originalCreateObjectURL(blob);
    urls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
    return originalRevokeObjectURL(url);
  };
  state.document.createElement = (tag) => {
    const el = originalCreateElement(tag);
    if (tag === 'a') {
      anchors.push(el);
      const originalClick = el.click.bind(el);
      el.click = () => {
        const ev = originalClick();
        anchorClickEvents.push(ev);
        return ev;
      };
    }
    return el;
  };

  try {
    await action();
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    state.document.createElement = originalCreateElement;
  }

  return { blobs, urls, revoked, anchors, anchorClickEvents };
}

test('Export with entries downloads a versioned JSON file, cleans up its anchor and flashes feedback', async () => {
  const state = await bootPopup({
    debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 0, maxEntries: 200 },
  });

  // Track document-level clicks during the async anchor click to prove the
  // anchor's one-shot click listener stops propagation.
  let documentClicksDuringAnchor = 0;
  let watchingAnchor = false;
  state.document.addEventListener('click', () => {
    if (watchingAnchor) documentClicksDuringAnchor += 1;
  });

  const bodyChildrenBefore = state.document.body.children.length;
  const { blobs, urls, revoked, anchors, anchorClickEvents } = await captureDownload(state, async () => {
    state.el.exportDebugLog.click();
    watchingAnchor = true;
    await flush();
    watchingAnchor = false;
  });

  assert.equal(blobs.length, 1, 'exactly one Blob is created for the download');
  assert.equal(blobs[0].type, 'application/json');
  assert.equal(urls.length, 1, 'one object URL is minted');
  assert.equal(revoked.length, 1, 'the object URL is revoked after the click');
  assert.equal(revoked[0], urls[0]);
  assert.equal(anchors.length, 1, 'exactly one <a> element is created');
  assert.equal(anchors[0].download, DEBUG_LOG_EXPORT_FILENAME);
  assert.equal(anchors[0].href, urls[0]);
  assert.equal(anchorClickEvents.length, 1, 'the anchor was clicked once');
  assert.equal(anchorClickEvents[0]._stopped, true, 'the one-shot anchor click listener stopped propagation');
  assert.equal(documentClicksDuringAnchor, 0, 'the anchor click never reached the document listener');
  assert.equal(
    state.document.body.children.length,
    bodyChildrenBefore,
    'the one-shot anchor is removed from document.body after the click',
  );
  assert.equal(anchors[0].parentNode, null);

  const rawText = await blobs[0].text();
  const parsed = JSON.parse(rawText);
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.exportedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(parsed.exportedAt)), 'exportedAt is a valid ISO timestamp');
  assert.equal(parsed.maxEntries, 200);
  assert.equal(parsed.entriesDropped, 0);
  assert.deepEqual(parsed.entries, ENTRIES);
  assert.equal(parsed.entries[0].query, 'n=12,fp=ab12cd34', 'the redacted query shape survives intact');
  assert.ok(!rawText.includes('plaintext-secret-search'), 'no plaintext search term appears in the exported file');

  assert.equal(state.el.exportDebugLog.textContent, 'Exported.');
  assert.ok(
    logMessages(state).some((p) => p.message === 'Debug log exported (2 entries).'),
    'the export is logged via logInfo',
  );

  state.tick(FEEDBACK_DURATION);
  assert.equal(state.el.exportDebugLog.textContent, 'Export log', 'the label resets after FEEDBACK_DURATION');
});

test('Export round-trips the truncation disclosure (entriesDropped, #19)', async () => {
  const state = await bootPopup({
    debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 7, maxEntries: 200 },
  });

  const { blobs } = await captureDownload(state, async () => {
    state.el.exportDebugLog.click();
    await flush();
  });

  assert.equal(blobs.length, 1);
  const parsed = JSON.parse(await blobs[0].text());
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entriesDropped, 7, 'the truncation drop count round-trips in the exported JSON');
  assert.equal(parsed.maxEntries, 200);
  assert.deepEqual(parsed.entries, ENTRIES);
});

test('Export with an empty log does nothing and flashes "Nothing to export."', async () => {
  const state = await bootPopup(); // default empty success

  const { blobs, urls, anchors } = await captureDownload(state, async () => {
    state.el.exportDebugLog.click();
    await flush();
  });

  assert.equal(blobs.length, 0, 'no Blob is created for an empty log');
  assert.equal(urls.length, 0, 'no object URL is minted');
  assert.equal(anchors.length, 0, 'no anchor is created');
  assert.equal(state.el.exportDebugLog.textContent, 'Nothing to export.');
  assert.ok(!logMessages(state).some((p) => p.message.startsWith('Debug log exported')));

  state.tick(FEEDBACK_DURATION);
  assert.equal(state.el.exportDebugLog.textContent, 'Export log', 'the label returns to idle after FEEDBACK_DURATION');
});

test('Export on background read failure does nothing, does not crash and flashes feedback', async () => {
  const state = await bootPopup({ debugLogResponse: 'error' });

  const { blobs, urls, anchors } = await captureDownload(state, async () => {
    state.el.exportDebugLog.click();
    await flush();
  });

  assert.equal(blobs.length, 0, 'no Blob is created on read failure');
  assert.equal(urls.length, 0, 'no object URL is minted on read failure');
  assert.equal(anchors.length, 0, 'no anchor is created on read failure');
  assert.equal(state.el.exportDebugLog.textContent, 'Nothing to export.');

  state.tick(FEEDBACK_DURATION);
  assert.equal(state.el.exportDebugLog.textContent, 'Export log', 'the label recovers after FEEDBACK_DURATION');
});

test('i18n: export button and feedback labels resolve through chrome.i18n', async () => {
  const state = await bootPopup({
    i18nMessages: {
      export_log: 'Protokoll exportieren',
      export_nothing: 'Nichts zu exportieren.',
      export_done: 'Exportiert.',
    },
  });

  assert.equal(state.el.exportDebugLog.textContent, 'Protokoll exportieren');
  state.el.exportDebugLog.click();
  await flush();
  assert.equal(state.el.exportDebugLog.textContent, 'Nichts zu exportieren.');
  state.tick(FEEDBACK_DURATION);
  assert.equal(state.el.exportDebugLog.textContent, 'Protokoll exportieren');
});

// ---------------------------------------------------------------------------
// Pure serializer unit checks (popupRules.js)
// ---------------------------------------------------------------------------
test('serializeDebugLogForExport: empty / missing / non-array entries return an empty string', () => {
  assert.equal(serializeDebugLogForExport([]), '');
  assert.equal(serializeDebugLogForExport(null), '');
  assert.equal(serializeDebugLogForExport(undefined), '');
  assert.equal(serializeDebugLogForExport('nope'), '');
});

test('serializeDebugLogForExport: honours injected exportedAt and preserves the exact payload shape', () => {
  const fixedTime = '2026-11-25T11:30:00.000Z';
  const json = serializeDebugLogForExport(ENTRIES, 7, 200, fixedTime);
  assert.deepEqual(JSON.parse(json), {
    version: 1,
    exportedAt: fixedTime,
    maxEntries: 200,
    entriesDropped: 7,
    entries: ENTRIES,
  });

  const withDefaults = JSON.parse(serializeDebugLogForExport(ENTRIES));
  assert.equal(withDefaults.version, 1);
  assert.equal(withDefaults.maxEntries, 200);
  assert.equal(withDefaults.entriesDropped, 0);
  assert.ok(!Number.isNaN(Date.parse(withDefaults.exportedAt)));
  assert.deepEqual(withDefaults.entries, ENTRIES);
});
