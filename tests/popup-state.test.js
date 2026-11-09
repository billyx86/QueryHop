// Unit tests for the pure save-flow / feedback / preset-picker logic in
// QueryHop Extension/Resources/popupState.js (extracted from popup.js in
// issue #22).
//
// Run with `node --test` (see package.json). popupState.js is deliberately
// free of DOM and chrome.* access, so no mocking is needed — this suite
// imports the module directly, same as popup-rules.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRESET_BUTTON_TEXT,
  SAVE_FEEDBACK_STATES,
  COPY_FEEDBACK_STATES,
  SAVE_PAYLOAD_KEYS,
  DEFAULT_SEARCH_URL,
  RESTORE_DEFAULTS,
  shouldAutoDisableExtension,
  buildSavePayload,
  nextFeedbackState,
  nextCopyFeedbackState,
  restoreFieldValues,
  presetLabelForUrl,
  presetCloseOnOutsideClick,
  USER_PRESETS_KEY,
  USER_PRESET_LIMIT,
  DEFAULT_USER_PRESETS,
  addUserPreset,
  renameUserPreset,
  deleteUserPreset,
  normalizeUserPresets,
  PRESET_EXPORT_FILENAME,
  serializeUserPresetsForExport,
  parsePresetImport,
  mergeImportedPresets,
} from '../QueryHop Extension/Resources/popupState.js';

// ---------------------------------------------------------------------------
// Save flow: chrome.storage.local.set payload shape
// ---------------------------------------------------------------------------

test('buildSavePayload writes exactly the four settings keys, together', () => {
  const payload = buildSavePayload({
    customUrl: 'https://duckduckgo.com/?q=%s',
    allowUnsafeMode: false,
    extensionChecked: true,
    debugLogEnabled: true,
  });
  assert.deepEqual(Object.keys(payload).sort(), [...SAVE_PAYLOAD_KEYS].sort());
  assert.equal(payload.customSearchUrl, 'https://duckduckgo.com/?q=%s');
  assert.equal(payload.allowUnsafeMode, false);
  assert.equal(payload.extensionEnabled, true);
  assert.equal(payload.debugLogEnabled, true);
});

test('buildSavePayload coerces the booleans', () => {
  const payload = buildSavePayload({
    customUrl: 'https://duckduckgo.com/?q=%s',
    allowUnsafeMode: 1,
    extensionChecked: 1,
    debugLogEnabled: '1',
  });
  assert.equal(payload.allowUnsafeMode, true);
  assert.equal(payload.extensionEnabled, true);
  assert.equal(payload.debugLogEnabled, true);
});

test('empty URL auto-disables the extension (checkbox left checked)', () => {
  const payload = buildSavePayload({
    customUrl: '',
    allowUnsafeMode: false,
    extensionChecked: true,
    debugLogEnabled: false,
  });
  assert.equal(payload.extensionEnabled, false);
  assert.equal(shouldAutoDisableExtension(''), true);
});

test('whitespace-only URL auto-disables the extension', () => {
  assert.equal(shouldAutoDisableExtension('   \t'), true);
  assert.equal(shouldAutoDisableExtension('https://x.com/?q=%s'), false);
});

test('empty URL does not re-enable an unchecked extension', () => {
  const payload = buildSavePayload({
    customUrl: '',
    allowUnsafeMode: false,
    extensionChecked: false,
    debugLogEnabled: false,
  });
  assert.equal(payload.extensionEnabled, false);
});

// ---------------------------------------------------------------------------
// Save button feedback state machine
// ---------------------------------------------------------------------------

test('feedback state: success → Saved! with success-flash', () => {
  const state = nextFeedbackState('success');
  assert.equal(state.label, 'Saved!');
  assert.equal(state.className, 'success-flash');
  assert.deepEqual(state, SAVE_FEEDBACK_STATES.success);
});

test('feedback state: success + extension disabled → Saved! (Disabled) with warning-flash', () => {
  const state = nextFeedbackState('success', { isDisabledReminder: true });
  assert.equal(state.label, 'Saved! (Disabled)');
  assert.equal(state.className, 'warning-flash');
  assert.deepEqual(state, SAVE_FEEDBACK_STATES.successDisabled);
});

test('feedback state: error → Error! with error-flash', () => {
  const state = nextFeedbackState('error');
  assert.equal(state.label, 'Error!');
  assert.equal(state.className, 'error-flash');
  assert.deepEqual(state, SAVE_FEEDBACK_STATES.error);
});

test('feedback state: reset (no type) → default label, no flash class', () => {
  const state = nextFeedbackState();
  assert.equal(state.label, 'Save Options');
  assert.equal(state.className, '');
  assert.deepEqual(state, SAVE_FEEDBACK_STATES.default);
  // unknown types behave like a reset, never a crash
  assert.deepEqual(nextFeedbackState('bogus'), SAVE_FEEDBACK_STATES.default);
});

// ---------------------------------------------------------------------------
// Copy-log feedback state
// ---------------------------------------------------------------------------

test('copy state: failed GET_DEBUG_LOG → "Nothing to copy", no log entry', () => {
  const state = nextCopyFeedbackState({ success: false, error: 'nope' }, 0, true, 'pending');
  assert.equal(state.label, COPY_FEEDBACK_STATES.nothing);
  assert.equal(state.log, false);
  const nullResponse = nextCopyFeedbackState(null, 0, true, 'pending');
  assert.equal(nullResponse.label, COPY_FEEDBACK_STATES.nothing);
});

test('copy state: successful but empty log → "Nothing to copy"', () => {
  const state = nextCopyFeedbackState({ success: true, entries: [] }, 0, true, 'pending');
  assert.equal(state.label, COPY_FEEDBACK_STATES.nothing);
  assert.equal(state.log, false);
});

test('copy state: clipboard write ok → "Copied!" and a log entry', () => {
  const state = nextCopyFeedbackState({ success: true, entries: [1, 2] }, 2, true, 'ok');
  assert.equal(state.label, COPY_FEEDBACK_STATES.copied);
  assert.equal(state.log, true);
});

test('copy state: execCommand fallback ok → "Copied!" and a log entry', () => {
  const state = nextCopyFeedbackState({ success: true, entries: [1] }, 1, false, 'fallback-ok');
  assert.equal(state.label, COPY_FEEDBACK_STATES.copied);
  assert.equal(state.log, true);
});

test('copy state: clipboard write failed → "Copy failed", no log entry', () => {
  const state = nextCopyFeedbackState({ success: true, entries: [1] }, 1, true, 'fallback-failed');
  assert.equal(state.label, COPY_FEEDBACK_STATES.failed);
  assert.equal(state.log, false);
  const errored = nextCopyFeedbackState({ success: true, entries: [1] }, 1, false, 'fallback-error');
  assert.equal(errored.label, COPY_FEEDBACK_STATES.failed);
});

// ---------------------------------------------------------------------------
// Preset picker
// ---------------------------------------------------------------------------

const PRESETS = [
  { url: 'https://www.ask.com/web?q=%s&o=0', name: 'Ask.com' },
  { url: 'https://search.brave.com/search?q=%s', name: 'Brave' },
  { url: 'http://localhost:8080/search?q=%s', name: 'SearXNG Docker Default [localhost:8080]' },
];

test('presetLabelForUrl: matches the preset whose data-url equals the current URL', () => {
  assert.equal(presetLabelForUrl(PRESETS, 'https://search.brave.com/search?q=%s'), 'Brave');
  assert.equal(
    presetLabelForUrl(PRESETS, 'http://localhost:8080/search?q=%s'),
    'SearXNG Docker Default [localhost:8080]',
  );
});

test('presetLabelForUrl: no match (custom URL) → default button text', () => {
  assert.equal(presetLabelForUrl(PRESETS, 'https://duckduckgo.com/?q=%s'), DEFAULT_PRESET_BUTTON_TEXT);
  assert.equal(presetLabelForUrl(PRESETS, ''), DEFAULT_PRESET_BUTTON_TEXT);
});

test('presetLabelForUrl: matching item without a name → default button text', () => {
  const presets = [{ url: 'https://x.com/?q=%s', name: '' }];
  assert.equal(presetLabelForUrl(presets, 'https://x.com/?q=%s'), DEFAULT_PRESET_BUTTON_TEXT);
});

// ---------------------------------------------------------------------------
// Preset dropdown outside-click decision
// ---------------------------------------------------------------------------

function makeContains(inside) {
  return { contains: (target) => inside.includes(target) };
}

test('presetCloseOnOutsideClick: closed dropdown never closes', () => {
  const outside = {};
  const result = presetCloseOnOutsideClick({
    open: false,
    dropdown: makeContains([outside]),
    toggleButton: makeContains([outside]),
    target: outside,
  });
  assert.equal(result, false);
});

test('presetCloseOnOutsideClick: open + click inside dropdown → stays open', () => {
  const item = {};
  const toggle = {};
  assert.equal(
    presetCloseOnOutsideClick({
      open: true,
      dropdown: makeContains([item]),
      toggleButton: makeContains([toggle]),
      target: item,
    }),
    false,
  );
});

test('presetCloseOnOutsideClick: open + click on toggle button → stays open', () => {
  const toggle = {};
  assert.equal(
    presetCloseOnOutsideClick({
      open: true,
      dropdown: makeContains([]),
      toggleButton: makeContains([toggle]),
      target: toggle,
    }),
    false,
  );
});

test('presetCloseOnOutsideClick: open + click elsewhere → closes', () => {
  const other = {};
  assert.equal(
    presetCloseOnOutsideClick({
      open: true,
      dropdown: makeContains([]),
      toggleButton: makeContains([]),
      target: other,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Restore flow: chrome.storage.local.get → form field values (issue #64)
// ---------------------------------------------------------------------------

test('RESTORE_DEFAULTS is exactly the four save keys with blank defaults', () => {
  // The restore defaults must mirror buildSavePayload's keys so the read and
  // write paths can never drift apart.
  assert.deepEqual(Object.keys(RESTORE_DEFAULTS), SAVE_PAYLOAD_KEYS);
  assert.equal(RESTORE_DEFAULTS.customSearchUrl, '');
  assert.equal(RESTORE_DEFAULTS.allowUnsafeMode, false);
  assert.equal(RESTORE_DEFAULTS.extensionEnabled, false);
  assert.equal(RESTORE_DEFAULTS.debugLogEnabled, false);
  assert.equal(DEFAULT_SEARCH_URL, '');
});

test('restoreFieldValues: maps all four stored values onto the form', () => {
  const fields = restoreFieldValues({
    customSearchUrl: 'https://kagi.com/?q=%s',
    allowUnsafeMode: true,
    extensionEnabled: true,
    debugLogEnabled: true,
  });
  assert.equal(fields.customSearchUrl, 'https://kagi.com/?q=%s');
  assert.equal(fields.allowUnsafeMode, true);
  assert.equal(fields.extensionEnabled, true);
  assert.equal(fields.debugLogEnabled, true);
});

test('restoreFieldValues: a missing/malformed key falls back to the default', () => {
  // chrome normally fills missing keys with the .get() defaults, but a
  // malformed response must not write the string "undefined" into the URL.
  const fields = restoreFieldValues({});
  assert.equal(fields.customSearchUrl, '');
  assert.equal(fields.allowUnsafeMode, false);
  assert.equal(fields.extensionEnabled, false);
  assert.equal(fields.debugLogEnabled, false);

  const explicit = restoreFieldValues({ customSearchUrl: 'https://x.com/?q=%s' });
  assert.equal(explicit.customSearchUrl, 'https://x.com/?q=%s');
  assert.equal(explicit.debugLogEnabled, false);
});

test('restoreFieldValues: coerces checkbox values to booleans', () => {
  // Truthy/falsy storage values are normalized the way the DOM would.
  assert.equal(restoreFieldValues({ allowUnsafeMode: 1 }).allowUnsafeMode, true);
  assert.equal(restoreFieldValues({ extensionEnabled: 0 }).extensionEnabled, false);
  assert.equal(restoreFieldValues({ debugLogEnabled: null }).debugLogEnabled, false);
  assert.equal(restoreFieldValues({ debugLogEnabled: undefined }).debugLogEnabled, false);
});

// ---------------------------------------------------------------------------
// User-managed presets (issue #126): pure CRUD in popupState.js
// ---------------------------------------------------------------------------

test('USER_PRESETS_KEY / DEFAULT_USER_PRESETS: storage contract', () => {
  assert.equal(USER_PRESETS_KEY, 'userPresets');
  assert.deepEqual(DEFAULT_USER_PRESETS, []);
  assert.throws(() => { DEFAULT_USER_PRESETS.push({ name: 'x', url: 'y' }); });
});

test('addUserPreset: adds a valid preset and never mutates the input', () => {
  const presets = [{ name: 'Kagi', url: 'https://kagi.com/search?q=%s' }];
  const before = JSON.stringify(presets);
  const result = addUserPreset(presets, ' My Engine ', ' https://example.com/?q=%s ');
  assert.equal(result.ok, true);
  assert.deepEqual(result.presets, [
    { name: 'Kagi', url: 'https://kagi.com/search?q=%s' },
    { name: 'My Engine', url: 'https://example.com/?q=%s' },
  ]);
  // New array, input untouched (no aliasing the caller can later corrupt).
  assert.notEqual(result.presets, presets);
  assert.equal(JSON.stringify(presets), before);
});

test('addUserPreset: blank name → missing-name (trimmed)', () => {
  assert.deepEqual(addUserPreset([], '', 'https://x.com/?q=%s'), { ok: false, error: 'missing-name' });
  assert.deepEqual(addUserPreset([], '   ', 'https://x.com/?q=%s'), { ok: false, error: 'missing-name' });
  assert.deepEqual(addUserPreset([], null, 'https://x.com/?q=%s'), { ok: false, error: 'missing-name' });
});

test('addUserPreset: blank URL → empty-url, not the validator’s info-empty', () => {
  // validateSearchUrl() treats an empty URL as valid ('info-empty' — the
  // main field’s "blank disables redirection" rule), but a preset with no
  // URL redirects nothing, so it must be refused with its own code.
  assert.deepEqual(addUserPreset([], 'Name', ''), { ok: false, error: 'empty-url' });
  assert.deepEqual(addUserPreset([], 'Name', '   \t '), { ok: false, error: 'empty-url' });
  assert.deepEqual(addUserPreset([], 'Name', undefined), { ok: false, error: 'empty-url' });
});

test('addUserPreset: duplicate URL → duplicate', () => {
  const presets = [{ name: 'Kagi', url: 'https://kagi.com/search?q=%s' }];
  const result = addUserPreset(presets, 'Kagi copy', 'https://kagi.com/search?q=%s');
  assert.deepEqual(result, { ok: false, error: 'duplicate' });
  // Whitespace-padded duplicates still match after trimming.
  assert.deepEqual(
    addUserPreset(presets, 'Kagi copy', '  https://kagi.com/search?q=%s  '),
    { ok: false, error: 'duplicate' },
  );
});

test('addUserPreset: URL failing validation → validator’s English message', async () => {
  const noPlaceholder = addUserPreset([], 'Name', 'https://example.com/search');
  assert.equal(noPlaceholder.ok, false);
  assert.equal(noPlaceholder.error, 'URL must include %s in place of your query');

  const badPrefix = addUserPreset([], 'Name', 'ftp://example.com/?q=%s');
  assert.equal(badPrefix.ok, false);
  assert.equal(badPrefix.error, 'URL must start with http(s)://');

  // The message must round-trip through makeLocalizedValidationMessage() —
  // an unknown string would pass through untouched and the controller would
  // render a raw validator sentence.
  const { makeT, makeLocalizedValidationMessage } =
    await import('../QueryHop Extension/Resources/popupI18n.js');
  const localize = makeLocalizedValidationMessage(makeT(() => ''));
  assert.equal(localize(noPlaceholder.error), 'URL must include %s in place of your query');
  assert.equal(localize(badPrefix.error), 'URL must start with http(s)://');
});

test('addUserPreset: blocked scheme is refused even in unsafe mode', () => {
  const result = addUserPreset([], 'Name', 'javascript:alert(1)', { allowUnsafe: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'URL scheme is not allowed, even in unsafe mode');
});

test('addUserPreset: unsafe mode relaxes %s / http(s) but still validates', () => {
  const result = addUserPreset([], 'Name', 'ftp://mirror.example.com/search?q=test', { allowUnsafe: true });
  // ftp: is not on the blocked-scheme denylist, so unsafe mode lets it through.
  assert.equal(result.ok, true);
  assert.equal(result.presets.length, 1);
  assert.equal(result.presets[0].url, 'ftp://mirror.example.com/search?q=test');
});

test('renameUserPreset: renames the entry at index, immutably', () => {
  const presets = [
    { name: 'Old', url: 'https://a.com/?q=%s' },
    { name: 'Keep', url: 'https://b.com/?q=%s' },
  ];
  const result = renameUserPreset(presets, 0, '  New Name  ');
  assert.equal(result.ok, true);
  assert.deepEqual(result.presets, [
    { name: 'New Name', url: 'https://a.com/?q=%s' },
    { name: 'Keep', url: 'https://b.com/?q=%s' },
  ]);
  assert.notEqual(result.presets, presets);
  assert.equal(presets[0].name, 'Old');
});

test('renameUserPreset: blank name → missing-name', () => {
  const presets = [{ name: 'Old', url: 'https://a.com/?q=%s' }];
  assert.deepEqual(renameUserPreset(presets, 0, ''), { ok: false, error: 'missing-name' });
  assert.deepEqual(renameUserPreset(presets, 0, '   '), { ok: false, error: 'missing-name' });
  assert.deepEqual(renameUserPreset(presets, 0, null), { ok: false, error: 'missing-name' });
});

test('renameUserPreset: out-of-range / non-integer index → not-found', () => {
  const presets = [{ name: 'Old', url: 'https://a.com/?q=%s' }];
  assert.deepEqual(renameUserPreset([], 0, 'Name'), { ok: false, error: 'not-found' });
  assert.deepEqual(renameUserPreset(presets, 1, 'Name'), { ok: false, error: 'not-found' });
  assert.deepEqual(renameUserPreset(presets, -1, 'Name'), { ok: false, error: 'not-found' });
  assert.deepEqual(renameUserPreset(presets, 0.5, 'Name'), { ok: false, error: 'not-found' });
});

test('deleteUserPreset: removes the entry at index, immutably', () => {
  const presets = [
    { name: 'A', url: 'https://a.com/?q=%s' },
    { name: 'B', url: 'https://b.com/?q=%s' },
    { name: 'C', url: 'https://c.com/?q=%s' },
  ];
  const result = deleteUserPreset(presets, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.presets, [
    { name: 'A', url: 'https://a.com/?q=%s' },
    { name: 'C', url: 'https://c.com/?q=%s' },
  ]);
  assert.notEqual(result.presets, presets);
  assert.equal(presets.length, 3);
});

test('deleteUserPreset: out-of-range / non-integer index → not-found', () => {
  assert.deepEqual(deleteUserPreset([], 0), { ok: false, error: 'not-found' });
  assert.deepEqual(deleteUserPreset([{ name: 'A', url: 'u' }], 1), { ok: false, error: 'not-found' });
  assert.deepEqual(deleteUserPreset([{ name: 'A', url: 'u' }], -1), { ok: false, error: 'not-found' });
  assert.deepEqual(deleteUserPreset([{ name: 'A', url: 'u' }], '0'), { ok: false, error: 'not-found' });
});

test('normalizeUserPresets: missing / malformed input → []', () => {
  assert.deepEqual(normalizeUserPresets(undefined), []);
  assert.deepEqual(normalizeUserPresets(null), []);
  assert.deepEqual(normalizeUserPresets('nope'), []);
  assert.deepEqual(normalizeUserPresets({ name: 'obj', url: 'u' }), []);
  assert.deepEqual(normalizeUserPresets([]), []);
});

test('normalizeUserPresets: trims entries, drops incomplete ones', () => {
  const normalized = normalizeUserPresets([
    { name: '  Kagi  ', url: '  https://kagi.com/search?q=%s  ' },
    { name: 'No URL', url: '   ' },
    { name: '   ', url: 'https://x.com/?q=%s' },
    'garbage',
    null,
    42,
    { url: 'https://y.com/?q=%s' },
  ]);
  assert.deepEqual(normalized, [{ name: 'Kagi', url: 'https://kagi.com/search?q=%s' }]);
});

test('normalizeUserPresets: input array is not mutated', () => {
  const input = [{ name: ' Kagi ', url: ' https://kagi.com/search?q=%s ' }];
  const before = JSON.stringify(input);
  normalizeUserPresets(input);
  assert.equal(JSON.stringify(input), before);
});

// ---------------------------------------------------------------------------
// Preset export / import (issue #135): the pure backup/restore decisions
// ---------------------------------------------------------------------------

test('PRESET_EXPORT_FILENAME: the download name is frozen product copy', () => {
  assert.equal(PRESET_EXPORT_FILENAME, 'queryhop-presets.json');
});

test('serializeUserPresetsForExport: pretty JSON of the normalized list', () => {
  const serialized = serializeUserPresetsForExport([
    { name: '  Kagi  ', url: '  https://kagi.com/search?q=%s  ' },
    { name: 'No URL', url: '   ' },
    null,
  ]);
  assert.deepEqual(JSON.parse(serialized), [{ name: 'Kagi', url: 'https://kagi.com/search?q=%s' }]);
  assert.equal(serialized, JSON.stringify([{ name: 'Kagi', url: 'https://kagi.com/search?q=%s' }], null, 2), 'two-space indent, so the file is human-diffable');
});

test('parsePresetImport: a bare array (the shape the exporter writes)', () => {
  const parsed = parsePresetImport(JSON.stringify([
    { name: 'Kagi', url: 'https://kagi.com/search?q=%s' },
    { name: ' ', url: 'https://x.com/?q=%s' },
  ]));
  assert.deepEqual(parsed, { ok: true, presets: [{ name: 'Kagi', url: 'https://kagi.com/search?q=%s' }] });
});

test('parsePresetImport: a hand-labelled {userPresets: [...]} wrapper also imports', () => {
  const parsed = parsePresetImport(JSON.stringify({ userPresets: [{ name: 'Kagi', url: 'https://kagi.com/search?q=%s' }] }));
  assert.deepEqual(parsed, { ok: true, presets: [{ name: 'Kagi', url: 'https://kagi.com/search?q=%s' }] });
});

test('parsePresetImport: invalid JSON / missing text → invalid-json', () => {
  assert.deepEqual(parsePresetImport('{ nope'), { ok: false, error: 'invalid-json' });
  assert.deepEqual(parsePresetImport(''), { ok: false, error: 'invalid-json' });
  assert.deepEqual(parsePresetImport(null), { ok: false, error: 'invalid-json' });
});

test('parsePresetImport: a single bare preset object (not wrapped in an array) imports (issue #152)', () => {
  // A user with one preset who copies just that object — no array, no
  // { userPresets } wrapper — gets a valid one-element import, not
  // not-a-list.
  const parsed = parsePresetImport(JSON.stringify({ name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' }));
  assert.deepEqual(parsed, { ok: true, presets: [{ name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' }] });
});

test('parsePresetImport: a single object with a blank name is dropped, not misread as a preset (issue #152)', () => {
  // The single-object shape is recognized loosely (it carries preset
  // fields), so a blank-name object still parses — and then normalizes to
  // an empty import, like the array case would.
  const parsed = parsePresetImport(JSON.stringify({ name: '  ', url: 'https://duckduckgo.com/?q=%s' }));
  assert.deepEqual(parsed, { ok: true, presets: [] });
});

test('parsePresetImport: a root that is neither shape → not-a-list', () => {
  assert.deepEqual(parsePresetImport(JSON.stringify({ foo: 1 })), { ok: false, error: 'not-a-list' });
  assert.deepEqual(parsePresetImport(JSON.stringify('kagi')), { ok: false, error: 'not-a-list' });
  assert.deepEqual(parsePresetImport(JSON.stringify(42)), { ok: false, error: 'not-a-list' });
});

test('mergeImportedPresets: appends new presets, skips duplicates, never mutates inputs', () => {
  const existing = [{ name: 'Kagi', url: 'https://kagi.com/search?q=%s' }];
  const imported = [
    { name: 'Kagi Again', url: 'https://kagi.com/search?q=%s' },
    { name: 'Brave', url: 'https://search.brave.com/search?q=%s' },
  ];
  const before = JSON.stringify([existing, imported]);
  const merged = mergeImportedPresets(existing, imported);
  assert.equal(JSON.stringify([existing, imported]), before, 'neither input array is mutated');
  assert.equal(merged.ok, true);
  assert.equal(merged.added, 1);
  assert.equal(merged.skipped, 1);
  assert.deepEqual(merged.presets, [
    { name: 'Kagi', url: 'https://kagi.com/search?q=%s' },
    { name: 'Brave', url: 'https://search.brave.com/search?q=%s' },
  ]);
  assert.notEqual(merged.presets, existing, 'the result is a new array');
});

test('mergeImportedPresets: one invalid URL rejects the WHOLE import', () => {
  const merged = mergeImportedPresets(
    [],
    [
      { name: 'Good', url: 'https://kagi.com/search?q=%s' },
      { name: 'NoPlaceholder', url: 'https://example.com/search?q=' },
    ],
  );
  assert.equal(merged.ok, false, 'atomicity: nothing is half-applied');
  assert.equal(merged.error, 'URL must include %s in place of your query', 'the error is the exact validator string, for the controller to localize');
});

test('mergeImportedPresets: unsafe mode relaxes the rules, blocked schemes are still refused', () => {
  const relaxed = mergeImportedPresets(
    [],
    [{ name: 'Raw', url: 'https://example.com/no-placeholder' }],
    { allowUnsafe: true },
  );
  assert.equal(relaxed.ok, true);
  assert.equal(relaxed.added, 1);

  const blocked = mergeImportedPresets(
    [],
    [{ name: 'Evil', url: 'javascript:alert(1)' }],
    { allowUnsafe: true },
  );
  assert.equal(blocked.ok, false, 'a poisoned URL never reaches the rules engine, even in unsafe mode');
  assert.equal(blocked.error, 'URL scheme is not allowed, even in unsafe mode');
});

test('export → import round-trip: parse(serialize(list)) equals the normalized list', () => {
  const list = [
    { name: 'Kagi', url: 'https://kagi.com/search?q=%s' },
    { name: 'Brave', url: 'https://search.brave.com/search?q=%s' },
  ];
  const reimported = parsePresetImport(serializeUserPresetsForExport(list));
  assert.equal(reimported.ok, true);
  assert.deepEqual(reimported.presets, list, 'an unmodified export file re-imports one-to-one');
});

// ---------------------------------------------------------------------------
// mergeImportedPresets: naming the rejected entry (issue #144)
// ---------------------------------------------------------------------------

test('mergeImportedPresets: a rejected import surfaces the offending entry (issue #144)', () => {
  const merged = mergeImportedPresets(
    [],
    [
      { name: 'Good', url: 'https://kagi.com/search?q=%s' },
      { name: 'NoPlaceholder', url: 'https://example.com/search?q=' },
    ],
  );
  assert.equal(merged.ok, false);
  assert.equal(
    merged.error,
    'URL must include %s in place of your query',
    'the error is still the exact validator string, for the controller to localize',
  );
  assert.deepEqual(
    merged.entry,
    { name: 'NoPlaceholder', url: 'https://example.com/search?q=' },
    'the offending entry is surfaced, not just its message',
  );
});

test('mergeImportedPresets: the surfaced entry is a fresh copy, not the caller object (issue #144)', () => {
  const bad = { name: 'Evil', url: 'javascript:alert(1)' };
  const merged = mergeImportedPresets([], [bad], { allowUnsafe: true });
  assert.equal(merged.ok, false);
  assert.notEqual(merged.entry, bad, 'the surfaced entry must be a copy, not the caller object');
  assert.deepEqual(merged.entry, bad);
  merged.entry.name = 'mutated';
  assert.equal(bad.name, 'Evil', 'mutating the surfaced entry never reaches the caller object');
});

// ---------------------------------------------------------------------------
// User-preset cap (issue #146)
// ---------------------------------------------------------------------------

// Distinct, validator-happy URLs so the cap — not validation — is what the
// assertions are exercising.
function validPresets(count, prefix) {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}${i}`,
    url: `https://${prefix}${i}.example.com/?q=%s`,
  }));
}

test('addUserPreset: the list is capped at USER_PRESET_LIMIT (issue #146)', () => {
  const full = validPresets(USER_PRESET_LIMIT, 'p');
  const atCap = addUserPreset(full, 'OneTooMany', 'https://toomany.example.com/?q=%s');
  assert.equal(atCap.ok, false, 'adding at the cap is refused');
  assert.equal(atCap.error, 'limit-reached', 'the cap is a distinct, mappable failure');
  assert.equal(atCap.presets, undefined, 'nothing is appended at the cap');
  assert.equal(full.length, USER_PRESET_LIMIT, 'the input list is untouched');

  const below = addUserPreset(full.slice(0, -1), 'OneMore', 'https://toomany.example.com/?q=%s');
  assert.equal(below.ok, true, 'adding one below the cap still works');
  assert.equal(below.presets.length, USER_PRESET_LIMIT, 'a successful add lands exactly on the cap');
});

test('mergeImportedPresets: import overflow past the cap is folded into skipped (issue #146)', () => {
  const existing = validPresets(USER_PRESET_LIMIT - 2, 'e');
  const imported = validPresets(5, 'n');
  const merged = mergeImportedPresets(existing, imported);
  assert.equal(merged.ok, true, 'the import is non-atomic: it adds up to the cap');
  assert.equal(merged.presets.length, USER_PRESET_LIMIT, 'the list never exceeds the cap');
  assert.equal(merged.added, 2, 'only the room below the cap is filled');
  assert.equal(merged.skipped, 3, 'the overflow past the cap counts as skipped, like duplicates');
});
