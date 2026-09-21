// Pure state helpers for the options popup (extracted from popup.js in
// issue #22).
//
// popup.js is the DOM layer; the small decision functions below lived inline
// in it with zero direct test coverage. They are extracted here, deliberately
// free of DOM and chrome.* access, so the `node --test` suite can import the
// module directly — same pattern as popupRules.js (issue #14).

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
