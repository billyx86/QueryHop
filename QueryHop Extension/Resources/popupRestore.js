//
//  popupRestore.js
//  QueryHop Extension
//
// The options restore / reset flow — split out of popup.js in #64, same
// factory-over-a-shared-context pattern as popupPreset.js / popupDebug.js
// (#53). Owns restoreOptions (chrome.storage.local.get -> fill the form ->
// re-check the URL -> refresh preset label and debug pane) and
// resetToDefaults (clear the form to its untouched state).
//
// The pure field mapping (restoreFieldValues over RESTORE_DEFAULTS) and the
// default URL live in popupState.js, unit-tested under Node; this module
// keeps only the DOM + chrome wiring, taking the shared plumbing from
// createPopupCore.js (chromeStorageGet, logging, performUrlCheck) and the
// preset / debug controllers via ctx.

import {
  DEFAULT_SEARCH_URL,
  RESTORE_DEFAULTS,
  restoreFieldValues,
} from './popupState.js';

export function createRestoreController(ctx) {
  const {
    elements,
    chromeStorageGet,
    logInfo,
    logToBackground,
    handleError,
    performUrlCheck,
    toggleUnsafeWarning,
    setUrlCheckStatus,
    resetValidationCache,
    updatePresetButtonText,
    resetPresetDropdown,
    loadDebugLog,
    ERROR_TYPES,
  } = ctx;

  function resetToDefaults() {
    if (elements.urlInput) elements.urlInput.value = DEFAULT_SEARCH_URL;
    if (elements.unsafeModeCheckbox) elements.unsafeModeCheckbox.checked = false;
    if (elements.enableExtensionCheckbox) elements.enableExtensionCheckbox.checked = false;
    if (elements.debugLogCheckbox) elements.debugLogCheckbox.checked = false;
    if (elements.advancedOptionsContainer) elements.advancedOptionsContainer.style.display = 'none';
    if (elements.toggleAdvancedButton) elements.toggleAdvancedButton.setAttribute('aria-expanded', 'false');
    resetPresetDropdown();

    resetValidationCache();

    toggleUnsafeWarning();
    setUrlCheckStatus('');
    updatePresetButtonText('');
  }

  // Restore the stored settings into the form. On a storage read failure
  // (e.g. chrome.storage unavailable) fall back to the defaults so the form
  // is always in a sane state, and log the failure for the debug pane.
  async function restoreOptions() {
    try {
      const items = await chromeStorageGet(RESTORE_DEFAULTS);
      const values = restoreFieldValues(items);

      if (elements.urlInput) elements.urlInput.value = values.customSearchUrl;
      if (elements.unsafeModeCheckbox) elements.unsafeModeCheckbox.checked = values.allowUnsafeMode;
      if (elements.enableExtensionCheckbox) elements.enableExtensionCheckbox.checked = values.extensionEnabled;
      if (elements.debugLogCheckbox) elements.debugLogCheckbox.checked = values.debugLogEnabled;

      toggleUnsafeWarning();
      performUrlCheck();
      updatePresetButtonText(elements.urlInput.value);
      loadDebugLog();
    } catch (error) {
      handleError(ERROR_TYPES.STORAGE, `Error loading settings: ${error.message || 'Unknown error'}`, error);
      resetToDefaults();
      logToBackground('error', 'Error loading settings shown via console/log.');
      logInfo('Settings restore failed; defaults applied.');
    }
  }

  // No listeners of its own — popup.js drives restoreOptions() once at the
  // end of boot. The reset flow is exposed for the storage-failure path and
  // the tests.
  return { restoreOptions, resetToDefaults };
}
