//
//  popup.js
//  QueryHop Extension
//
// Composition root for the options popup — wiring only, no flow logic
// (issue #64). The behavior lives in focused modules:
//
//   popupCore.js     shared plumbing: per-boot timers, background-log
//                    bridge, cached URL check, storage wrapper, and the
//                    "generic" control listeners            (#64)
//   popupSave.js     the options save flow (save button, Enter) (#64)
//   popupRestore.js  the options restore / reset flow       (#64)
//   popupPreset.js   the preset picker                      (#53)
//   popupDebug.js    the debug-log pane                     (#53)
//
// Pure, Node-testable logic stays in popupRules.js (URL validation) and
// popupState.js (save/restore state machines); i18n lives in
// popupI18n.js (#21): every user-facing string resolves through t() —
// chrome.i18n with an English-literal fallback. Static markup is localized
// via the data-i18n* attributes in popup.html (applied in initializePopup).

import {
  makeT,
  applyI18n,
  makeLocalizedSaveLabel,
  makeLocalizedValidationMessage,
  syncDocumentLanguage,
} from './popupI18n.js';
import {
  createPopupCore,
  ERROR_TYPES,
  FEEDBACK_DURATION,
} from './popupCore.js';
import { createSaveController } from './popupSave.js';
import { createRestoreController } from './popupRestore.js';
import { createPresetController } from './popupPreset.js';
import { createDebugController } from './popupDebug.js';

document.addEventListener('DOMContentLoaded', () => {
  const elements = {
    urlInput: document.getElementById('searchUrl'),
    saveButton: document.getElementById('save'),
    unsafeModeCheckbox: document.getElementById('unsafeMode'),
    unsafeWarningDiv: document.getElementById('unsafeWarning'),
    enableExtensionCheckbox: document.getElementById('enableExtension'),
    urlCheckStatusDiv: document.getElementById('urlCheckStatus'),
    presetToggleBtn: document.getElementById('presetToggleBtn'),
    presetDropdown: document.getElementById('presetDropdown'),
    presetToggleText: document.getElementById('presetToggleText'),
    toggleAdvancedButton: document.getElementById('toggleAdvanced'),
    advancedOptionsContainer: document.getElementById('advancedOptions'),
    debugLogCheckbox: document.getElementById('debugLog'),
    debugLogView: document.getElementById('debugLogView'),
    refreshDebugLogBtn: document.getElementById('refreshDebugLog'),
    clearDebugLogBtn: document.getElementById('clearDebugLog'),
    copyDebugLogBtn: document.getElementById('copyDebugLog'),
  };

  // i18n (#21): every user-facing string resolves through t(), which wraps
  // chrome.i18n.getMessage and falls back to the English literal when the
  // key is missing or the runtime lacks chrome.i18n.
  const t = makeT(
    typeof chrome !== 'undefined' &&
    chrome.i18n &&
    typeof chrome.i18n.getMessage === 'function'
      ? (key, subs) => chrome.i18n.getMessage(key, subs)
      : null
  );

  // Accessibility (#46): sync <html lang> to the browser UI language.
  syncDocumentLanguage(
    (typeof navigator !== 'undefined' && navigator.language) || 'en',
    document.documentElement
  );

  // Shared plumbing (popupCore.js): timer bookkeeping, the background-log
  // bridge, the cached URL check, the storage wrapper, and the generic
  // control listeners. The validation-message mapper is pre-built (pure,
  // popupI18n.js) and handed in so the core keeps no i18n logic.
  const core = createPopupCore({
    elements,
    localizedValidationMessage: makeLocalizedValidationMessage(t),
  });

  // The preset picker and debug pane (popupPreset.js / popupDebug.js, #53)
  // are factories over the shared context, so the pure decisions stay
  // unit-tested in popupState.js / popupRules.js while only the DOM wiring
  // lives in the controller modules. This file stays the composition root.
  const presetController = createPresetController({
    elements,
    t,
    logInfo: core.logInfo,
    performUrlCheck: core.performUrlCheck,
  });
  const debugController = createDebugController({
    elements,
    t,
    logInfo: core.logInfo,
    handleError: core.handleError,
    ERROR_TYPES,
    FEEDBACK_DURATION,
  });

  // Save / restore flows (popupSave.js / popupRestore.js, #64). The
  // save-button label mapper is pre-built the same way (pure,
  // popupI18n.js); the preset-button updates close over the preset
  // controller, built above.
  const saveController = createSaveController({
    elements,
    manageTimeout: core.manageTimeout,
    logInfo: core.logInfo,
    handleError: core.handleError,
    performUrlCheck: core.performUrlCheck,
    localizedSaveLabel: makeLocalizedSaveLabel(t),
    updatePresetButtonText: presetController.updateButtonText,
    ERROR_TYPES,
    FEEDBACK_DURATION,
  });
  const restoreController = createRestoreController({
    elements,
    chromeStorageGet: core.chromeStorageGet,
    logInfo: core.logInfo,
    logToBackground: core.logToBackground,
    handleError: core.handleError,
    performUrlCheck: core.performUrlCheck,
    toggleUnsafeWarning: core.toggleUnsafeWarning,
    setUrlCheckStatus: core.setUrlCheckStatus,
    resetValidationCache: core.resetValidationCache,
    updatePresetButtonText: presetController.updateButtonText,
    resetPresetDropdown: presetController.resetDropdown,
    loadDebugLog: debugController.loadDebugLog,
    ERROR_TYPES,
  });

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
      if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveController.saveOptions();
      }
    });
  }

  function initializePopup() {
    const essentialElements = [
      elements.urlInput,
      elements.saveButton,
      elements.unsafeModeCheckbox,
      elements.enableExtensionCheckbox,
      elements.toggleAdvancedButton,
      elements.advancedOptionsContainer,
      elements.presetToggleBtn,
      elements.presetDropdown,
      elements.presetToggleText,
    ];

    if (essentialElements.some(el => !el)) {
      core.handleError(ERROR_TYPES.DOM, 'Initialization failed: One or more essential UI elements are missing.');
      // Localized directly: applyI18n() never runs on this path, since
      // the elements it needs are exactly what is missing here.
      const message = t('popup_init_failed', 'Error: Could not initialize popup UI.');
      document.body.innerHTML = `<p style="color: red; padding: 1em;">${message}</p>`;
      return;
    }

    // Localize the static markup (labels, buttons, hints, placeholder).
    // The English literal in the HTML is the fallback, so a missing key
    // — or a runtime without chrome.i18n — degrades to the current UI.
    applyI18n(t, document);

    core.logInfo('Popup initializing...');
    setupKeyboardShortcuts();
    core.wireGenericControls(presetController.updateButtonText);
    saveController.wireEvents();
    presetController.wireEvents();
    debugController.wireEvents();
    restoreController.restoreOptions();
    if (elements.urlInput) elements.urlInput.focus();
    core.logInfo('Popup initialized successfully.');
  }

  initializePopup();
});
