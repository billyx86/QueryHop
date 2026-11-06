// Preset export / import UI (issue #135): the DOM wiring of the real preset
// controller (popupPreset.js) driven through the real popup.js against the
// fake browser environment in tests/popup-harness.js.
//
// The pure decisions (serializeUserPresetsForExport / parsePresetImport /
// mergeImportedPresets) are unit-tested in tests/popup-state.test.js; this
// file covers the controller around them: the Export/Import buttons in the
// manage row, the aria-live status line, the visually-hidden file input, the
// Blob/URL download flow (and that its one-shot anchor never reaches the
// document-level outside-click handler), and the async file.read -> merge ->
// persist -> re-render path.
//
// The harness runs on Node 22, where `Blob`, `File` and
// `URL.createObjectURL` are real globals, so the export flow exercises the
// genuine download path — no stubbing of the Blob/URL machinery.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootPopup, logMessages, flush } from './popup-harness.js';
import {
  PRESET_EXPORT_FILENAME,
  serializeUserPresetsForExport,
} from '../QueryHop Extension/Resources/popupState.js';

const resourceDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'QueryHop Extension',
  'Resources',
);

const DDG_URL = 'https://duckduckgo.com/?q=%s';
const ECOSIA_URL = 'https://www.ecosia.org/search?q=%s';

// Live user-preset rows only — scoped to the list element so re-rendered
// (detached) rows are never picked up by the harness's registry-wide
// document.querySelectorAll.
function userRows(state) {
  return state.el.presetUserList.querySelectorAll('.preset-item-user');
}

function openDropdown(state) {
  state.el.presetToggleBtn.click();
  state.tick(50); // the 50ms first-item focus delay
  assert.equal(state.el.presetDropdown.style.display, 'block', 'the dropdown opens');
}

test('Export with no presets → empty-list status, no download', async () => {
  const state = await bootPopup();
  openDropdown(state);

  state.el.presetExportBtn.click();

  const status = state.el.presetManageStatus;
  assert.equal(status.className, 'validation-status invalid');
  assert.equal(status.textContent, 'Nothing to export yet. Add a preset first.');
  assert.equal(state.storage.userPresets, undefined, 'an empty export writes nothing');
});

test('Export downloads the normalized list, removes its anchor, keeps the dropdown open', async () => {
  const state = await bootPopup({
    storage: { userPresets: [{ name: ' DuckDuckGo ', url: `  ${DDG_URL}  ` }] },
  });
  openDropdown(state);

  // Capture the download machinery at the moment the controller calls it:
  // one Blob is created, one object URL minted, exactly one <a> element,
  // with a one-shot click listener that stops propagation.
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalCreateElement = state.document.createElement;
  const blobs = [];
  const urls = [];
  const revoked = [];
  const anchors = [];
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
    if (tag === 'a') anchors.push(el);
    return el;
  };

  const bodyChildrenBefore = state.document.body.children.length;
  try {
    state.el.presetExportBtn.click();
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    state.document.createElement = originalCreateElement;
  }

  assert.equal(blobs.length, 1, 'exactly one Blob is created for the download');
  assert.equal(blobs[0].type, 'application/json');
  assert.equal(urls.length, 1, 'the Blob is served from one object URL');
  assert.deepEqual(
    JSON.parse(blobs[0] instanceof Blob ? (await blobs[0].text()) : blobs[0]),
    [{ name: 'DuckDuckGo', url: DDG_URL }],
    'the exported file is the normalized preset list (trimmed, stored shape)',
  );
  assert.equal(anchors.length, 1, 'exactly one <a> element is created');
  assert.equal(anchors[0].download, PRESET_EXPORT_FILENAME, 'the download name is the frozen product copy');
  assert.equal(anchors[0].href, urls[0], 'the anchor points at the object URL');
  assert.equal(revoked.length, 1, 'the object URL is released after the click');
  assert.equal(revoked[0], urls[0]);
  assert.equal(
    state.document.body.children.length,
    bodyChildrenBefore,
    'the one-shot anchor is removed from the body after the click',
  );
  assert.equal(
    state.el.presetDropdown.style.display,
    'block',
    'the programmatic click never reaches the document outside-click handler — the dropdown stays open',
  );
  assert.equal(state.el.presetManageStatus.className, 'validation-status valid');
  assert.equal(state.el.presetManageStatus.textContent, 'Presets exported');
  assert.ok(
    logMessages(state).some((p) => p.message === 'Preset list exported (1 presets).'),
    'the export is logged to the background debug log',
  );
});

test('Import: the Import button opens the hidden file input and resets it after the change', async () => {
  const state = await bootPopup();
  openDropdown(state);
  assert.equal(state.el.presetImportFile.getAttribute('type'), 'file');
  assert.equal(state.el.presetImportFile.getAttribute('accept'), '.json,application/json');
  assert.ok(state.el.presetImportFile._classes.has('visually-hidden'), 'the input is the visually-hidden file picker');

  // No file chosen yet: a bare change event is ignored.
  state.el.presetImportFile.dispatchEvent('change', {});
  assert.equal(state.el.presetManageStatus.textContent, '');

  // Import clicks the file input (the harness has no native picker).
  const importClicks = [];
  const originalClick = state.el.presetImportFile.click.bind(state.el.presetImportFile);
  state.el.presetImportFile.click = () => {
    importClicks.push(1);
    return originalClick();
  };
  state.el.presetImportBtn.click();
  assert.equal(importClicks.length, 1, 'the Import button triggers the file picker');
  assert.equal(state.el.presetDropdown.style.display, 'block', 'the picker click keeps the dropdown open');
});

test('Import a valid preset list: merged, persisted, rendered, logged', async () => {
  const state = await bootPopup({
    storage: { userPresets: [{ name: 'DuckDuckGo', url: DDG_URL }] },
  });
  openDropdown(state);

  state.el.presetImportFile.files = [
    new File([JSON.stringify([{ name: 'Ecosia', url: ECOSIA_URL }])], 'backup.json', { type: 'application/json' }),
  ];
  state.el.presetImportFile.dispatchEvent('change', {});
  await flush();

  assert.deepEqual(state.storage.userPresets, [
    { name: 'DuckDuckGo', url: DDG_URL },
    { name: 'Ecosia', url: ECOSIA_URL },
  ], 'the imported preset is appended and persisted immediately');
  assert.equal(userRows(state).length, 2, 'the re-render shows both presets');
  assert.equal(userRows(state)[1].querySelector('.preset-name').textContent, 'Ecosia');
  assert.equal(state.el.presetManageStatus.className, 'validation-status valid');
  assert.equal(state.el.presetManageStatus.textContent, 'Presets imported');
  assert.equal(state.el.presetImportFile.value, '', 'the file input is reset so the same file can be re-selected');
  assert.ok(
    logMessages(state).some((p) => p.message === 'Preset list imported (1 added, 0 skipped).'),
    'the import is logged to the background debug log',
  );
});

test('Import a file that is not valid JSON → invalid-json status, list untouched', async () => {
  const state = await bootPopup({
    storage: { userPresets: [{ name: 'DuckDuckGo', url: DDG_URL }] },
  });
  openDropdown(state);

  state.el.presetImportFile.files = [new File(['not json {'], 'broken.json')];
  state.el.presetImportFile.dispatchEvent('change', {});
  await flush();

  assert.equal(state.el.presetManageStatus.className, 'validation-status invalid');
  assert.equal(state.el.presetManageStatus.textContent, 'That file is not valid JSON');
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: DDG_URL }]);
});

test('Import a root that is neither array nor {userPresets: []} → not-a-list status', async () => {
  const state = await bootPopup({
    storage: { userPresets: [{ name: 'DuckDuckGo', url: DDG_URL }] },
  });
  openDropdown(state);

  state.el.presetImportFile.files = [new File([JSON.stringify({ foo: 1 })], 'weird.json')];
  state.el.presetImportFile.dispatchEvent('change', {});
  await flush();

  assert.equal(state.el.presetManageStatus.className, 'validation-status invalid');
  assert.equal(state.el.presetManageStatus.textContent, 'That file does not contain a preset list');
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: DDG_URL }]);
});

test('Import with a poisoned URL rejects the WHOLE import (atomicity)', async () => {
  const state = await bootPopup({
    storage: { userPresets: [{ name: 'DuckDuckGo', url: DDG_URL }] },
  });
  openDropdown(state);

  // Two entries, one bad: the good one must NOT land — a half-imported
  // backup is worse than no import.
  state.el.presetImportFile.files = [
    new File(
      [JSON.stringify([
        { name: 'Ecosia', url: ECOSIA_URL },
        { name: 'NoPlaceholder', url: 'https://example.com/search?q=' },
      ])],
      'mixed.json',
    ),
  ];
  state.el.presetImportFile.dispatchEvent('change', {});
  await flush();

  assert.equal(state.el.presetManageStatus.className, 'validation-status invalid');
  assert.equal(
    state.el.presetManageStatus.textContent,
    'URL must include %s in place of your query',
    'the validator message is mapped through the localized validation table',
  );
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: DDG_URL }], 'nothing is added when any URL fails validation');
});

test('Import a list where every preset already exists → all-skipped info status', async () => {
  const state = await bootPopup({
    storage: { userPresets: [{ name: 'DuckDuckGo', url: DDG_URL }] },
  });
  openDropdown(state);

  state.el.presetImportFile.files = [
    new File([JSON.stringify([{ name: 'Another DDG', url: DDG_URL }])], 'dup.json'),
  ];
  state.el.presetImportFile.dispatchEvent('change', {});
  await flush();

  assert.equal(state.el.presetManageStatus.className, 'validation-status info-bypass');
  assert.equal(state.el.presetManageStatus.textContent, 'Those presets are already in your list');
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: DDG_URL }], 'duplicates are skipped, not re-added');
});

test('Unsafe mode relaxes the %s/http(s) import rules; blocked schemes are still refused', async () => {
  const state = await bootPopup();
  state.el.unsafeMode.checked = true;
  openDropdown(state);

  // No placeholder — normally rejected, accepted under unsafe mode.
  state.el.presetImportFile.files = [
    new File([JSON.stringify([{ name: 'Raw', url: 'https://example.com/no-placeholder' }])], 'raw.json'),
  ];
  state.el.presetImportFile.dispatchEvent('change', {});
  await flush();

  assert.deepEqual(state.storage.userPresets, [{ name: 'Raw', url: 'https://example.com/no-placeholder' }]);
  assert.equal(state.el.presetManageStatus.className, 'validation-status valid');

  // A blocked scheme is refused even in unsafe mode — atomicity again.
  state.el.presetImportFile.files = [
    new File([JSON.stringify([{ name: 'Evil', url: 'javascript:alert(1)' }])], 'evil.json'),
  ];
  state.el.presetImportFile.dispatchEvent('change', {});
  await flush();

  assert.equal(state.el.presetManageStatus.className, 'validation-status invalid');
  assert.equal(
    state.el.presetManageStatus.textContent,
    'URL scheme is not allowed, even in unsafe mode',
  );
  assert.deepEqual(state.storage.userPresets, [{ name: 'Raw', url: 'https://example.com/no-placeholder' }]);
});

test('Export → Import round-trip: an unmodified file re-imports one-to-one', async () => {
  const source = await bootPopup({
    storage: {
      userPresets: [
        { name: 'DuckDuckGo', url: DDG_URL },
        { name: 'Ecosia', url: ECOSIA_URL },
      ],
    },
  });
  openDropdown(source);

  const originalCreateObjectURL = URL.createObjectURL;
  let exportedBlob = null;
  URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return originalCreateObjectURL(blob);
  };
  try {
    source.el.presetExportBtn.click();
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
  }
  assert.ok(exportedBlob instanceof Blob, 'the export produced a Blob');
  const exportedText = await exportedBlob.text();

  // A fresh popup (no storage) imports the exported file.
  const target = await bootPopup();
  openDropdown(target);
  target.el.presetImportFile.files = [new File([exportedText], PRESET_EXPORT_FILENAME, { type: 'application/json' })];
  target.el.presetImportFile.dispatchEvent('change', {});
  await flush();

  assert.deepEqual(target.storage.userPresets, [
    { name: 'DuckDuckGo', url: DDG_URL },
    { name: 'Ecosia', url: ECOSIA_URL },
  ], 'the round-trip restores the exact stored list');
  assert.equal(userRows(target).length, 2);
  assert.equal(target.el.presetManageStatus.textContent, 'Presets imported');
});

test('i18n: the manage status messages resolve through chrome.i18n', async () => {
  const state = await bootPopup({
    i18nMessages: {
      preset_export: 'Presets exportieren',
      preset_export_empty: 'Noch nichts zu exportieren. Füge zuerst ein Preset hinzu.',
      preset_export_done: 'Presets exportiert',
    },
  });
  openDropdown(state);

  state.el.presetExportBtn.click();

  assert.equal(
    state.el.presetManageStatus.textContent,
    'Noch nichts zu exportieren. Füge zuerst ein Preset hinzu.',
    'the empty-export status uses the localized message',
  );
  // The static button labels are localized by applyI18n() through data-i18n.
  assert.equal(state.el.presetExportBtn.textContent, 'Presets exportieren', 'the Export button is localized from its data-i18n key');
});

test('static markup: the manage row, status line and hidden file input ship in popup.html', () => {
  const html = fs.readFileSync(path.join(resourceDir, 'popup.html'), 'utf8');
  const css = fs.readFileSync(path.join(resourceDir, 'popup.css'), 'utf8');

  const exportBtn = html.match(/<button\b[^>]*\bid="presetExportBtn"[^>]*>/);
  const importBtn = html.match(/<button\b[^>]*\bid="presetImportBtn"[^>]*>/);
  const status = html.match(/<div\b[^>]*\bid="presetManageStatus"[^>]*>/);
  const fileInput = html.match(/<input\b[^>]*\bid="presetImportFile"[^>]*>/);
  assert.ok(exportBtn, 'the Export button exists in the static markup');
  assert.ok(importBtn, 'the Import button exists in the static markup');
  assert.ok(status, 'the aria-live status line exists in the static markup');
  assert.ok(fileInput, 'the file input exists in the static markup');
  assert.match(exportBtn[0], /class="button-small button-small-secondary"/);
  assert.match(exportBtn[0], /data-i18n="preset_export"/);
  assert.match(importBtn[0], /class="button-small button-small-secondary"/);
  assert.match(importBtn[0], /data-i18n="preset_import"/);
  assert.match(status[0], /class="validation-status"/);
  assert.match(status[0], /aria-live="polite"/);
  assert.match(fileInput[0], /type="file"/);
  assert.match(fileInput[0], /class="visually-hidden"/);
  assert.match(fileInput[0], /accept="\.json,application\/json"/);
  assert.ok(
    /\.visually-hidden\s*{/.test(css),
    'the visually-hidden utility class the file input relies on is defined in popup.css',
  );
  // The manage row is a real flex row (gap keeps the three buttons apart).
  assert.match(css, /\.preset-manage-row\s*{[^}]*gap:/);
  assert.ok(
    serializeUserPresetsForExport,
    'the pure helper the markup drives is exported by popupState.js',
  );
});
