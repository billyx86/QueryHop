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
  shouldAutoDisableExtension,
  buildSavePayload,
  nextFeedbackState,
  nextCopyFeedbackState,
  presetLabelForUrl,
  presetCloseOnOutsideClick,
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
