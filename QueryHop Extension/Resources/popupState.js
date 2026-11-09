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

// Hard cap on the number of user presets (issue #146). Both mutation paths
// — the add form (addUserPreset) and file import (mergeImportedPresets) —
// respect it, so a user who repeatedly imports ever-larger backups cannot
// grow an unbounded list that makes the dropdown unscannable. Documented
// product copy, shared by the controller and the tests so neither drifts.
export const USER_PRESET_LIMIT = 100;

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
//   { ok: false, error: 'limit-reached' }         the list is at
//                                                  USER_PRESET_LIMIT
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
  // The cap is checked before the URL is touched (issue #146): a full list
  // refuses the add with 'limit-reached' regardless of the URL, because the
  // user cannot add anything until they delete an entry — the two failure
  // kinds map to different user-facing messages, and the cap is the more
  // fundamental blocker.
  if (presets.length >= USER_PRESET_LIMIT) {
    return { ok: false, error: 'limit-reached' };
  }
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
//   { ok: false, error: 'not-found' }. The input array is never mutated.
export function deleteUserPreset(presets, index) {
  if (!Number.isInteger(index) || index < 0 || index >= presets.length) {
    return { ok: false, error: 'not-found' };
  }
  const next = presets.slice();
  next.splice(index, 1);
  return { ok: true, presets: next };
}

// ---------------------------------------------------------------------------
// Preset export / import (issue #135)
// ---------------------------------------------------------------------------

// The download name the export flow gives to the file. Frozen product copy,
// shared by the controller and the tests so neither can drift.
export const PRESET_EXPORT_FILENAME = 'queryhop-presets.json';

// Serialize the user preset list for export. The file is exactly the array
// shape USER_PRESETS_KEY stores — an array of { name, url } — so an
// unmodified re-import round-trips one-to-one. The list is normalized first
// (trim, drop incomplete entries), exactly as a corrupt storage read is on
// boot, so an export file can never carry a broken entry.
export function serializeUserPresetsForExport(presets) {
  return JSON.stringify(normalizeUserPresets(presets), null, 2);
}

// Parse the text of an imported file into a candidate preset list. The
// accepted root shapes are the bare array this export produces and a
// single-object wrapper ({ userPresets: [...] }) so a file the user labelled
// by hand still imports. Entries are normalized — incomplete ones dropped —
// mirroring normalizeUserPresets(). Returns
//   { ok: true,  presets }                    after normalization (may be [])
//   { ok: false, error: 'invalid-json' }      the text is not valid JSON
//   { ok: false, error: 'not-a-list' }        the root is neither shape
export function parsePresetImport(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  // Three accepted shapes: a bare preset array (the export format), a
  // { userPresets: [...] } wrapper, or a SINGLE bare preset object (issue
  // #152) — a user with one preset who copies just that object instead of
  // an array. A lone object is recognized loosely by its preset fields
  // (string name or url); anything else stays not-a-list. The object is
  // wrapped in an array so it normalizes — and gets the same name/url
  // filtering — like every array entry.
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? parsed.userPresets !== undefined
        ? parsed.userPresets
        : typeof parsed.name === 'string' || typeof parsed.url === 'string'
          ? [parsed]
          : undefined
      : undefined;
  if (!Array.isArray(raw)) return { ok: false, error: 'not-a-list' };
  return { ok: true, presets: normalizeUserPresets(raw) };
}

// Merge an imported list into the existing presets. Every imported URL is
// routed through the same validateSearchUrl() the add flow uses — and a
// single invalid URL rejects the WHOLE import. Atomicity is deliberate: a
// half-imported backup is worse than no import, and a poisoned URL must
// never reach the rules engine. Duplicates are skipped, not errors: the
// imported URL already exists (re-importing a stale export after the preset
// was re-added by hand), or the file repeats it — `skipped` counts both, as
// does overflow past USER_PRESET_LIMIT (issue #146): the import is not
// atomic about the cap, it simply fills the list to the cap and reports the
// rest as skipped, so a capped import is still a usable partial merge.
// Neither input array is mutated. Returns
//   { ok: true,  presets, added, skipped }     on success (presets is new;
//                                               added may be 0 — all dups or
//                                               the list was already at cap)
//   { ok: false, error: <English validation msg>, entry }  the first URL
//                                                  that failed validation
//                                                  (issue #144: `entry` is a
//                                                  fresh copy of the
//                                                  offending imported preset,
//                                                  surfaced so the status
//                                                  can name it); the
//                                                  controller runs `error`
//                                                  through
//                                                  localizedValidationMessage()
export function mergeImportedPresets(existing, imported, { allowUnsafe = false } = {}) {
  const seen = new Set(existing.map((entry) => entry.url));
  const next = existing.slice();
  let added = 0;
  let skipped = 0;
  for (const entry of imported) {
    const validation = validateSearchUrl(entry.url, allowUnsafe);
    if (!validation.isValid) {
      // Surface a copy — never the caller's object — so the controller can
      // display the name/URL without the import ever holding a reference
      // into test or file-parsing state (issue #144).
      return { ok: false, error: validation.message, entry: { name: entry.name, url: entry.url } };
    }
    if (next.length >= USER_PRESET_LIMIT) {
      // Cap overflow counts as skipped, like a duplicate (issue #146):
      // the list keeps whatever fits and the status reports the overflow.
      skipped += 1;
      continue;
    }
    if (seen.has(entry.url)) {
      skipped += 1;
      continue;
    }
    seen.add(entry.url);
    next.push({ name: entry.name, url: entry.url });
    added += 1;
  }
  return { ok: true, presets: next, added, skipped };
}
