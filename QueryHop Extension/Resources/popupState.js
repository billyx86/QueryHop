// Pure state helpers for the options popup (extracted from popup.js in
// issue #22).
//
// popup.js is the DOM layer; the small decision functions below lived inline
// in it with zero direct test coverage. They are extracted here, deliberately
// free of DOM and chrome.* access, so the `node --test` suite can import the
// module directly — same pattern as popupRules.js (issue #14).

import { validateSearchUrl } from './popupRules.js';

// ---------------------------------------------------------------------------
// Labels and feedback states (shared by popup.js and the test suite)
// ---------------------------------------------------------------------------

export const DEFAULT_PRESET_BUTTON_TEXT = 'Select Preset';

// The save button's text and flash-class per outcome of showSaveButtonFeedback.
export const SAVE_FEEDBACK_STATES = Object.freeze({
  default: { label: 'Save Options', className: '' },
  saving: { label: 'Saving...', className: '' },
  success: { label: 'Saved!', className: 'success-flash' },
  successDisabled: { label: 'Saved! (Disabled)', className: 'warning-flash' },
  error: { label: 'Error!', className: 'error-flash' },
});

// The copy-log button's text per outcome of the copy attempt.
export const COPY_FEEDBACK_STATES = Object.freeze({
  idle: 'Copy log',
  copied: 'Copied!',
  failed: 'Copy failed',
  nothing: 'Nothing to copy',
});

// ---------------------------------------------------------------------------
// Save flow (chrome.storage.local.set payload)
// ---------------------------------------------------------------------------

// The four settings keys the popup writes — always together, never partially.
export const SAVE_PAYLOAD_KEYS = Object.freeze([
  'customSearchUrl',
  'allowUnsafeMode',
  'extensionEnabled',
  'debugLogEnabled',
]);

// popup.js auto-disables the extension (and flips the checkbox) when the URL
// is empty — before validation runs. This is the decision, pure of DOM.
export function shouldAutoDisableExtension(customUrl) {
  return !customUrl.trim();
}

// Build the exact storage payload for the save flow. `extensionChecked` is
// the checkbox state as the user left it; the auto-disable rule above wins.
export function buildSavePayload({
  customUrl,
  allowUnsafeMode,
  extensionChecked,
  debugLogEnabled,
}) {
  const isExtensionEnabled = extensionChecked && !shouldAutoDisableExtension(customUrl);
  return {
    customSearchUrl: customUrl,
    allowUnsafeMode: Boolean(allowUnsafeMode),
    extensionEnabled: isExtensionEnabled,
    debugLogEnabled: Boolean(debugLogEnabled),
  };
}

// ---------------------------------------------------------------------------
// Save button feedback state machine
// ---------------------------------------------------------------------------

// type 'success' | 'error', or undefined/null for "reset to the default
// label with no flash". Returns the { label, className } to apply; the DOM
// layer (popup.js) applies it and schedules the timed reset back to
// `default` — the reset itself is a timer, not a state decision.
export function nextFeedbackState(type, { isDisabledReminder = false } = {}) {
  if (type === 'success') {
    return isDisabledReminder ? SAVE_FEEDBACK_STATES.successDisabled : SAVE_FEEDBACK_STATES.success;
  }
  if (type === 'error') {
    return SAVE_FEEDBACK_STATES.error;
  }
  return SAVE_FEEDBACK_STATES.default;
}

// ---------------------------------------------------------------------------
// Copy-log feedback state
// ---------------------------------------------------------------------------

// Decides the copy-log button state for one attempt:
//   response  — the GET_DEBUG_LOG runtime-message response (or null on failure)
//   entryCount— entries.length when the response succeeded
//   hasClipboard — whether navigator.clipboard.writeText exists
//   copyResult — 'pending' | 'ok' | 'fallback-ok' | 'fallback-failed'
//                | 'fallback-error' (anything but 'pending' implies the
//                async clipboard API was unavailable and the execCommand
//                fallback ran — or the async write was attempted; the state
//                mapping below is the same either way)
export function nextCopyFeedbackState(response, entryCount, hasClipboard, copyResult) {
  if (!response || !response.success) {
    return { label: COPY_FEEDBACK_STATES.nothing, log: false };
  }
  if (!entryCount) {
    return { label: COPY_FEEDBACK_STATES.nothing, log: false };
  }
  if (copyResult === 'pending') {
    return { label: hasClipboard ? COPY_FEEDBACK_STATES.idle : COPY_FEEDBACK_STATES.failed, log: false };
  }
  if (copyResult === 'ok' || copyResult === 'fallback-ok') {
    return { label: COPY_FEEDBACK_STATES.copied, log: true };
  }
  return { label: COPY_FEEDBACK_STATES.failed, log: false };
}

// ---------------------------------------------------------------------------
// Restore flow (chrome.storage.local.get + form reset)
// ---------------------------------------------------------------------------

// The default custom URL when nothing is stored (empty = extension
// disabled, per shouldAutoDisableExtension above).
export const DEFAULT_SEARCH_URL = "";

// The four settings keys the popup reads on boot, with the fallback values
// the form shows before anything has been saved. The same four keys
// buildSavePayload() writes — restore and save must never drift apart.
export const RESTORE_DEFAULTS = Object.freeze({
  customSearchUrl: '',
  allowUnsafeMode: false,
  extensionEnabled: false,
  debugLogEnabled: false,
});

// Map the chrome.storage.local.get items onto the form's field values,
// pure of DOM (issue #64). chrome always fills missing keys with the
// defaults passed to .get, but the ?? guard keeps a malformed response
// from writing the string "undefined" into the URL input. Checkbox values
// are coerced to booleans the same way the real DOM does on assignment.
export function restoreFieldValues(items) {
  return {
    customSearchUrl: items.customSearchUrl ?? RESTORE_DEFAULTS.customSearchUrl,
    allowUnsafeMode: Boolean(items.allowUnsafeMode),
    extensionEnabled: Boolean(items.extensionEnabled),
    debugLogEnabled: Boolean(items.debugLogEnabled),
  };
}

// ---------------------------------------------------------------------------
// Preset picker
// ---------------------------------------------------------------------------

// Resolve the label the preset toggle button should show for `currentUrl`:
// the .preset-name of the first preset item whose data-url matches, or the
// default text when no preset matches (e.g. a custom URL).
// `presets` is the list of { url, name } read from the dropdown items.
export function presetLabelForUrl(presets, currentUrl) {
  for (const preset of presets) {
    if (preset.url && preset.url === currentUrl) {
      return preset.name ? preset.name : DEFAULT_PRESET_BUTTON_TEXT;
    }
  }
  return DEFAULT_PRESET_BUTTON_TEXT;
}

// Should an outside click close the open preset dropdown? `open` is the
// current display state; the dropdown and toggle-button elements expose
// `.contains(target)` — both are only consulted when the dropdown is open.
export function presetCloseOnOutsideClick({ open, dropdown, toggleButton, target }) {
  if (!open) return false;
  return !(dropdown.contains(target) || toggleButton.contains(target));
}

// ---------------------------------------------------------------------------
// User-managed presets (issue #126)
// ---------------------------------------------------------------------------

// The chrome.storage.local key holding the user's own presets: an array of
// { name, url } objects in the same shape the built-in dropdown items expose.
// The built-in presets are static markup and never live in this store.
export const USER_PRESETS_KEY = 'userPresets';

// The fallback for a missing or malformed stored value — the dropdown
// renders the built-ins only. Frozen so a stray mutation cannot persist.
export const DEFAULT_USER_PRESETS = Object.freeze([]);

// Normalize a stored user-presets payload into the canonical array shape:
// a missing/malformed value yields [] (a corrupt storage read must never
// break the dropdown), non-object entries are dropped, and every kept entry
// is trimmed of surrounding whitespace. Entries whose name or URL ends up
// empty are dropped, mirroring what addUserPreset() refuses to create.
export function normalizeUserPresets(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      name: String(entry.name ?? '').trim(),
      url: String(entry.url ?? '').trim(),
    }))
    .filter((entry) => entry.name && entry.url);
}

// Add a user preset. The URL is routed through the same validateSearchUrl()
// the custom URL field uses — `allowUnsafe` honours the "Disable URL
// Validation" checkbox and blocked schemes are always rejected — and the
// URL must not duplicate an existing preset. The input array is never
// mutated. Returns
//   { ok: true,  presets }                        on success (a new array)
//   { ok: false, error: 'missing-name' }          name is empty after trimming
//   { ok: false, error: 'empty-url' }             URL is empty after trimming
//   { ok: false, error: 'duplicate' }             a preset with that URL exists
//   { ok: false, error: <English validation msg> } the URL failed validation;
//                                                  the message is the exact
//                                                  validateSearchUrl() string,
//                                                  for the controller to run
//                                                  through
//                                                  localizedValidationMessage()
export function addUserPreset(presets, name, url, { allowUnsafe = false } = {}) {
  const trimmedName = String(name ?? '').trim();
  const trimmedUrl = String(url ?? '').trim();
  if (!trimmedName) return { ok: false, error: 'missing-name' };
  // validateSearchUrl() reports an empty URL as valid ('info-empty' — the
  // main URL field's "blank disables redirection" rule), but a preset with
  // no URL cannot redirect anything, so refuse it before the validator.
  if (!trimmedUrl) return { ok: false, error: 'empty-url' };
  const validation = validateSearchUrl(trimmedUrl, allowUnsafe);
  if (!validation.isValid) return { ok: false, error: validation.message };
  if (presets.some((entry) => entry.url === trimmedUrl)) {
    return { ok: false, error: 'duplicate' };
  }
  return { ok: true, presets: [...presets, { name: trimmedName, url: trimmedUrl }] };
}

// Rename the preset at `index` — the name must be non-empty; the URL already
// passed validation when the preset was added, so it is not re-checked.
// Out-of-range index → { ok: false, error: 'not-found' }. The input array
// is never mutated.
export function renameUserPreset(presets, index, name) {
  const trimmedName = String(name ?? '').trim();
  if (!trimmedName) return { ok: false, error: 'missing-name' };
  if (!Number.isInteger(index) || index < 0 || index >= presets.length) {
    return { ok: false, error: 'not-found' };
  }
  const next = presets.slice();
  next[index] = { ...next[index], name: trimmedName };
  return { ok: true, presets: next };
}

// Delete the preset at `index`. Out-of-range index →
// { ok: false, error: 'not-found' }. The input array is never mutated.
export function deleteUserPreset(presets, index) {
  if (!Number.isInteger(index) || index < 0 || index >= presets.length) {
    return { ok: false, error: 'not-found' };
  }
  const next = presets.slice();
  next.splice(index, 1);
  return { ok: true, presets: next };
}
