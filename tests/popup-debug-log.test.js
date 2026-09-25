// Debug-log coverage for the REAL popup.js (issue #38): the copy-log button
// (clipboard API + execCommand fallback, #15), clear-log, the view's 50-entry
// cap and its truncation footer (#19), and the load-failure path.
//
// The exact line shapes come from popupRules.js (unit-tested there); here we
// drive the real click handlers and assert on the DOM + clipboard side
// effects, using the real formatter output as the expected text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootPopup, flush, logMessages, errorMessages } from './popup-harness.js';
import {
  DEBUG_LOG_COPY_NOTE,
  DEBUG_LOG_VIEW_LIMIT,
  formatDebugLogEntry,
  formatDebugLogForCopy,
  formatDebugLogViewText,
} from '../QueryHop Extension/Resources/popupRules.js';

const T1 = '2026-09-25T10:00:00.000Z';
const T2 = '2026-09-25T10:00:05.500Z';
const ENTRIES = [
  { event: 'redirect', engine: 'kagi', query: 'n=4,fp=abc', targetUrl: 'https://kagi.com/search?n=4', time: T1 },
  { event: 'blocked_scheme', targetUrl: 'javascript:alert(1)', originalUrl: 'https://evil.example', time: T2 },
];
const LINE1 = formatDebugLogEntry(ENTRIES[0]);
const LINE2 = formatDebugLogEntry(ENTRIES[1]);

test('renders entries from the background on boot, newest first', async () => {
  const state = await bootPopup({ debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 0, maxEntries: 200 } });

  assert.equal(state.el.debugLogView.textContent, `${LINE2}\n${LINE1}`);
});

test('renders the empty placeholder when the log has no entries', async () => {
  const state = await bootPopup(); // default response: success, empty
  assert.equal(state.el.debugLogView.textContent, 'Debug log is empty.');
});

test('discloses dropped entries with a footer line (#19)', async () => {
  const state = await bootPopup({ debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 3, maxEntries: 200 } });
  const expected = formatDebugLogViewText(ENTRIES, 3, 200);
  assert.equal(state.el.debugLogView.textContent, expected);
  assert.ok(state.el.debugLogView.textContent.includes('3 older entries were dropped this session.'));
});

test('caps the view at the most recent 50 entries, newest first', async () => {
  const count = DEBUG_LOG_VIEW_LIMIT + 3;
  const entries = Array.from({ length: count }, (_, i) => ({
    event: `evt-${String(i).padStart(2, '0')}`,
    time: `2026-09-25T10:0${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}.000Z`,
  }));
  const state = await bootPopup({ debugLogResponse: { success: true, entries, entriesDropped: 0, maxEntries: 200 } });

  const text = state.el.debugLogView.textContent;
  assert.equal(text, formatDebugLogViewText(entries, 0, 200));
  assert.ok(text.includes('evt-52'), 'the newest entry is shown');
  assert.ok(text.includes('evt-03'), 'the 50th-most-recent entry is shown');
  assert.ok(!text.includes('evt-00'), 'the oldest three entries are capped out');
  assert.ok(!text.includes('evt-01'));
  assert.ok(!text.includes('evt-02'));
});

test('copy-log writes the full (uncapped) export to the clipboard', async () => {
  const state = await bootPopup({
    clipboard: 'ok',
    debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 0, maxEntries: 200 },
  });

  state.el.copyDebugLog.click();
  await flush();

  assert.deepEqual(state.clipboardWriteCalls, [formatDebugLogForCopy(ENTRIES, 0, 200)]);
  const copied = state.clipboardWriteCalls[0];
  assert.ok(copied.startsWith('QueryHop debug log — 2 entries\n'));
  assert.ok(copied.includes(LINE1));
  assert.ok(copied.includes(LINE2));
  assert.ok(copied.includes(DEBUG_LOG_COPY_NOTE), 'the redaction note ships with the export');
  assert.equal(state.el.copyDebugLog.textContent, 'Copied!');
  assert.ok(logMessages(state).some((p) => p.message === 'Debug log copied to clipboard (2 entries).'));

  state.tick(1200);
  assert.equal(state.el.copyDebugLog.textContent, 'Copy log', 'the label resets after the feedback window');
});

test('copy-log includes the truncation note when entries were dropped', async () => {
  const state = await bootPopup({
    clipboard: 'ok',
    debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 7, maxEntries: 200 },
  });
  state.el.copyDebugLog.click();
  await flush();

  assert.deepEqual(state.clipboardWriteCalls, [formatDebugLogForCopy(ENTRIES, 7, 200)]);
  assert.ok(state.clipboardWriteCalls[0].includes('7 older entries were dropped this session.'));
});

test('copy-log without the clipboard API falls back to select + execCommand', async () => {
  const state = await bootPopup({
    // no clipboard option → navigator.clipboard is undefined
    debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 0, maxEntries: 200 },
  });

  state.el.copyDebugLog.click();
  await flush();

  assert.deepEqual(state.execCommandCalls, ['copy']);
  const helper = state.document.__registry.find((el) => el.tagName === 'TEXTAREA');
  assert.ok(helper, 'a temporary textarea helper is created');
  assert.equal(helper.selectCalls, 1, 'the helper text is selected');
  assert.equal(helper.value, formatDebugLogForCopy(ENTRIES, 0, 200));
  assert.equal(helper.parentNode, null, 'the helper is removed again after the copy');
  assert.equal(state.clipboardWriteCalls.length, 0, 'the async API was never available');
  assert.equal(state.el.copyDebugLog.textContent, 'Copied!');
  assert.ok(logMessages(state).some((p) => p.message === 'Debug log copied to clipboard (2 entries).'));
});

test('a rejected clipboard write falls back to execCommand', async () => {
  const state = await bootPopup({
    clipboard: 'reject',
    debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 0, maxEntries: 200 },
  });

  state.el.copyDebugLog.click();
  await flush();
  await flush(); // the rejection handler runs one microtask later

  assert.deepEqual(state.execCommandCalls, ['copy']);
  assert.equal(state.el.copyDebugLog.textContent, 'Copied!');
});

test('copy-log reports Copy failed when execCommand returns false', async () => {
  const state = await bootPopup({
    execCommandResult: false,
    debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 0, maxEntries: 200 },
  });

  state.el.copyDebugLog.click();
  await flush();

  assert.equal(state.el.copyDebugLog.textContent, 'Copy failed');
  assert.ok(errorMessages(state).some((m) => m.includes('Copy-log fallback (execCommand) returned false.')));
  assert.ok(!logMessages(state).some((p) => p.message.startsWith('Debug log copied to clipboard')));
});

test('copy-log reports Copy failed when execCommand throws', async () => {
  const state = await bootPopup({
    execCommandThrow: true,
    debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 0, maxEntries: 200 },
  });

  state.el.copyDebugLog.click();
  await flush();

  assert.equal(state.el.copyDebugLog.textContent, 'Copy failed');
  assert.ok(errorMessages(state).some((m) => m.includes('Copy-log fallback failed: execCommand exploded')));
});

test('copy-log with an empty log says Nothing to copy', async () => {
  const state = await bootPopup({ clipboard: 'ok' }); // default empty success

  state.el.copyDebugLog.click();
  await flush();

  assert.equal(state.el.copyDebugLog.textContent, 'Nothing to copy');
  assert.equal(state.clipboardWriteCalls.length, 0, 'nothing is written to the clipboard');
  assert.equal(state.execCommandCalls.length, 0);
  assert.ok(!logMessages(state).some((p) => p.message.startsWith('Debug log copied to clipboard')));
});

test('copy-log when the background refuses the read says Nothing to copy', async () => {
  const state = await bootPopup({ clipboard: 'ok', debugLogResponse: 'error' });

  state.el.copyDebugLog.click();
  await flush();

  assert.equal(state.el.copyDebugLog.textContent, 'Nothing to copy');
  assert.equal(state.clipboardWriteCalls.length, 0);
});

test('clear-log renders the empty placeholder on success', async () => {
  const state = await bootPopup({ debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 0, maxEntries: 200 } });
  assert.ok(state.el.debugLogView.textContent.includes(LINE1));

  state.el.clearDebugLog.click();
  await flush();

  assert.equal(state.el.debugLogView.textContent, 'Debug log is empty.');
  assert.ok(state.sentMessages.some((m) => m.type === 'CLEAR_DEBUG_LOG'));
});

test('clear-log shows the failure message when the background refuses', async () => {
  const state = await bootPopup({
    debugLogResponse: { success: true, entries: ENTRIES, entriesDropped: 0, maxEntries: 200 },
    clearLogResponse: { success: false, error: 'nope' },
  });

  state.el.clearDebugLog.click();
  await flush();

  assert.equal(state.el.debugLogView.textContent, 'Could not clear the debug log.');
});
