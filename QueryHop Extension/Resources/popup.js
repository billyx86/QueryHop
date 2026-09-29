//
//  popup.js
//  QueryHop Extension
//
// DOM wiring for the options popup. The pure rules/validation/formatting
// logic lives in popupRules.js and the pure save/preset/debug state machines
// in popupState.js (both imported below) so they can be unit-tested under
// Node. The preset picker and the debug-log pane are split out into
// popupPreset.js / popupDebug.js (#53) as factories over a shared context,
// leaving this file as the thin orchestrator: element lookups, i18n
// translation, validation caching, storage calls, the save flow, and the
// wiring that composes the two sub-controllers.
//
// i18n (#21): user-facing strings resolve through t() — chrome.i18n with an
// English-literal fallback, see popupI18n.js. Static markup is localized via
// the data-i18n* attributes in popup.html (applied in initializePopup); the
// validation-status switch below maps each pinned popupRules.js message to
// its i18n key. Save/copy feedback, preset and debug-pane strings are
// localized at their point of use in the modules that own them.

import {
  validateSearchUrl,
} from './popupRules.js';
import {
  SAVE_FEEDBACK_STATES,
  shouldAutoDisableExtension,
  buildSavePayload,
  nextFeedbackState,
} from './popupState.js';
import {
  makeT,
  applyI18n,
} from './popupI18n.js';
import {
  createPresetController,
} from './popupPreset.js';
import {
  createDebugController,
} from './popupDebug.js';

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

  // i18n (#21): every user-facing string resolves through t(), which
  // wraps chrome.i18n.getMessage and falls back to the English literal
  // when the key is missing or the runtime lacks chrome.i18n.
  const t = makeT(
    typeof chrome !== 'undefined' &&
    chrome.i18n &&
    typeof chrome.i18n.getMessage === 'function'
      ? (key, subs) => chrome.i18n.getMessage(key, subs)
      : null
  );

  // Accessibility (#46): popup.html declares lang="en" statically, but the
  // strings are resolved at runtime through chrome.i18n, which follows the
  // browser's UI language. Sync <html lang> to that language (base
  // language only — the lang attribute takes "de", not "de-DE"), so
  // screen readers and language-sensitive heuristics classify the popup
  // correctly. The host window solves the same problem the other way
  // around: its Main.html declares the locale and Script.js reads it back.
  function syncDocumentLanguage() {
    const language =
      (typeof navigator !== 'undefined' && navigator.language) || 'en';
    document.documentElement.lang = language.split('-')[0];
  }

  syncDocumentLanguage();

  // popupState.js keeps the English labels (unit-tested there); the i18n
  // key for each state is mapped here so the popup renders them in the
  // UI language. Unknown states fall through to the English label.
  function localizedSaveLabel(state) {
    if (state === SAVE_FEEDBACK_STATES.saving) return t('save_saving', state.label);
    if (state === SAVE_FEEDBACK_STATES.success) return t('save_success', state.label);
    if (state === SAVE_FEEDBACK_STATES.successDisabled) return t('save_success_disabled', state.label);
    if (state === SAVE_FEEDBACK_STATES.error) return t('save_error', state.label);
    return t('save_options', state.label);
  }

  // popupRules.js pins the English validation strings (unit-tested); map
  // each to its i18n key at the display boundary. Unknown strings pass
  // through untouched.
  function localizedValidationMessage(message) {
    switch (message) {
      case 'Leaving the URL empty will disable redirection':
        return t('validation_info_empty', message);
      case 'URL must include %s in place of your query':
        return t('validation_missing_placeholder', message);
      case 'URL must start with http(s)://':
        return t('validation_bad_prefix', message);
      case 'URL format valid':
        return t('validation_valid', message);
      case 'Invalid URL format':
        return t('validation_invalid', message);
      case 'URL scheme is not allowed, even in unsafe mode':
        return t('validation_blocked_scheme', message);
      case 'URL validation is disabled':
        return t('validation_bypassed', message);
      default:
        return message;
    }
  }

  const DEFAULT_SEARCH_URL = "";
  // Save-button labels and the preset default text live in popupState.js
  // (issue #22) so that state machine is unit-tested there;
  // FEEDBACK_DURATION below is only the reset timer.
  const FEEDBACK_DURATION = 1200;
  const INPUT_DEBOUNCE_DELAY = 300;
  const ERROR_TYPES = {
    STORAGE: 'storage_error',
    VALIDATION: 'validation_error',
    PERMISSION: 'permission_error',
    NETWORK: 'network_error',
    DOM: 'dom_error',
  };

  const validationCache = {
    lastUrl: null,
    lastUnsafeMode: null,
    result: null,
  };

  const timeouts = {
    urlCheck: null,
    saveButtonFeedback: null,
    urlInputDebounce: null,
  };

  function manageTimeout(type, callback, duration) {
    if (timeouts[type]) {
      clearTimeout(timeouts[type]);
      timeouts[type] = null;
    }
    if (duration > 0) {
      timeouts[type] = setTimeout(callback, duration);
    }
  }

  function logInfo(message, data = null) {
    logToBackground('log', message, data);
  }

  function logToBackground(level, message, data = null) {
    try {
      chrome.runtime.sendMessage({
        type: "LOG_MESSAGE",
        payload: {
          level,
          message,
          data: data ? JSON.stringify(data) : null,
          source: 'popup',
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      console[level](`[POPUP FALLBACK] ${message}`, data);
    }
  }

  function handleError(type, message, originalError = null) {
    logToBackground('error', `[${type}] ${message}`, originalError);
  }

  function toggleUnsafeWarning() {
    if (!elements.unsafeWarningDiv || !elements.unsafeModeCheckbox) return;

    const isChecked = elements.unsafeModeCheckbox.checked;
    elements.unsafeWarningDiv.style.display = isChecked ? 'block' : 'none';

    if (isChecked) {
      elements.unsafeWarningDiv.setAttribute('role', 'alert');
      elements.unsafeWarningDiv.setAttribute('aria-live', 'polite');
    } else {
      elements.unsafeWarningDiv.removeAttribute('role');
      elements.unsafeWarningDiv.removeAttribute('aria-live');
    }
  }

  function setUrlCheckStatus(text, type = '') {
    if (!elements.urlCheckStatusDiv || !elements.urlInput) return;

    if (elements.urlCheckStatusDiv.textContent === text &&
        elements.urlCheckStatusDiv.className === `validation-status ${type}`) {
      return;
    }

    elements.urlCheckStatusDiv.textContent = text;
    elements.urlCheckStatusDiv.className = `validation-status ${type}`;
    elements.urlCheckStatusDiv.setAttribute('role', 'status');
    elements.urlCheckStatusDiv.style.display = text ? 'block' : 'none';

    elements.urlInput.removeAttribute('aria-invalid');
    elements.urlInput.removeAttribute('aria-errormessage');

    if (type === 'invalid') {
      elements.urlInput.setAttribute('aria-invalid', 'true');
      elements.urlInput.setAttribute('aria-errormessage', 'urlCheckStatus');
      elements.urlCheckStatusDiv.setAttribute('role', 'alert');
      elements.urlCheckStatusDiv.setAttribute('aria-live', 'assertive');
    } else {
      elements.urlCheckStatusDiv.setAttribute('aria-live', 'polite');
    }
  }

  // Thin caching wrapper around the pure validator in popupRules.js. The
  // cache exists purely to avoid re-validating on every keystroke; the
  // result objects are produced (and tested) in the module.
  function validateUrl(url, isUnsafeMode) {
    if (url === validationCache.lastUrl && isUnsafeMode === validationCache.lastUnsafeMode && validationCache.result) {
      return validationCache.result;
    }

    const result = validateSearchUrl(url, isUnsafeMode);

    validationCache.lastUrl = url;
    validationCache.lastUnsafeMode = isUnsafeMode;
    validationCache.result = result;

    return result;
  }

  function performUrlCheck() {
    if (!elements.urlInput || !elements.unsafeModeCheckbox) {
      return { isValid: false };
    }

    const urlValue = elements.urlInput.value;
    const isUnsafe = elements.unsafeModeCheckbox.checked;
    const validation = validateUrl(urlValue, isUnsafe);

    setUrlCheckStatus(localizedValidationMessage(validation.message), validation.type);
    return validation;
  }

  function chromeStorageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (items) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(items);
        }
      });
    });
  }

  // --- The preset picker and debug-log pane (split out in #53) ------------
  // Both are factories over this shared context, so the pure decisions stay
  // unit-tested in popupState.js / popupRules.js while only the DOM wiring
  // (which needs the live elements and the i18n translator) lives in the
  // controller modules. popup.js stays the composition root.
  const presetController = createPresetController({
    elements,
    t,
    logInfo,
    handleError,
    performUrlCheck,
  });
  const debugController = createDebugController({
    elements,
    t,
    logInfo,
    handleError,
    ERROR_TYPES,
    FEEDBACK_DURATION,
  });

  function resetToDefaults() {
    if (elements.urlInput) elements.urlInput.value = DEFAULT_SEARCH_URL;
    if (elements.unsafeModeCheckbox) elements.unsafeModeCheckbox.checked = false;
    if (elements.enableExtensionCheckbox) elements.enableExtensionCheckbox.checked = false;
    if (elements.debugLogCheckbox) elements.debugLogCheckbox.checked = false;
    if (elements.advancedOptionsContainer) elements.advancedOptionsContainer.style.display = 'none';
    if (elements.toggleAdvancedButton) elements.toggleAdvancedButton.setAttribute('aria-expanded', 'false');
    presetController.resetDropdown();

    validationCache.lastUrl = null;
    validationCache.lastUnsafeMode = null;
    validationCache.result = null;

    toggleUnsafeWarning();
    setUrlCheckStatus('');
    presetController.updateButtonText('');
  }

  async function restoreOptions() {
    try {
      const items = await chromeStorageGet({
        customSearchUrl: DEFAULT_SEARCH_URL,
        allowUnsafeMode: false,
        extensionEnabled: false,
        debugLogEnabled: false,
      });

      if (elements.urlInput) elements.urlInput.value = items.customSearchUrl;
      if (elements.unsafeModeCheckbox) elements.unsafeModeCheckbox.checked = items.allowUnsafeMode;
      if (elements.enableExtensionCheckbox) elements.enableExtensionCheckbox.checked = items.extensionEnabled;
      if (elements.debugLogCheckbox) elements.debugLogCheckbox.checked = Boolean(items.debugLogEnabled);

      toggleUnsafeWarning();
      performUrlCheck();
      presetController.updateButtonText(elements.urlInput.value);
      debugController.loadDebugLog();
    } catch (error) {
      handleError(ERROR_TYPES.STORAGE, `Error loading settings: ${error.message || 'Unknown error'}`, error);
      resetToDefaults();
      logToBackground('error', 'Error loading settings shown via console/log.');
    }
  }

  function showSaveButtonFeedback(button, type, isDisabledReminder = false) {
    // The label/class decision is the tested state machine in
    // popupState.js; this only applies it and schedules the timed reset.
    const state = nextFeedbackState(type, { isDisabledReminder });
    const originalText = localizedSaveLabel(SAVE_FEEDBACK_STATES.default);
    const possibleClasses = ['success-flash', 'error-flash', 'warning-flash'];

    if (!state.className) {
      button.textContent = originalText;
      button.classList.remove(...possibleClasses);
      manageTimeout('saveButtonFeedback', () => {}, 0);
      return;
    }

    manageTimeout('saveButtonFeedback', () => {}, 0);
    button.textContent = localizedSaveLabel(state);

    if (button.classList.contains(state.className)) {
      possibleClasses.forEach(cls => {
        if(cls !== state.className) button.classList.remove(cls);
      });
    } else {
      button.classList.remove(...possibleClasses);
      void button.offsetHeight;
      button.classList.add(state.className);
    }

    manageTimeout('saveButtonFeedback', () => {
      button.textContent = originalText;
      button.classList.remove(state.className);
    }, FEEDBACK_DURATION);
  }

  async function saveOptions() {
    if (!elements.urlInput || !elements.unsafeModeCheckbox ||
        !elements.enableExtensionCheckbox || !elements.saveButton) {
      handleError(ERROR_TYPES.DOM, 'Save failed: Required UI elements not found.');
      return;
    }

    const saveButton = elements.saveButton;
    const customUrl = elements.urlInput.value;
    const isUnsafeEnabled = elements.unsafeModeCheckbox.checked;
    const isDebugLogEnabled = elements.debugLogCheckbox ? elements.debugLogCheckbox.checked : false;
    let isExtensionEnabled = elements.enableExtensionCheckbox.checked;

    if (shouldAutoDisableExtension(customUrl)) {
      isExtensionEnabled = false;
      if (elements.enableExtensionCheckbox) {
        elements.enableExtensionCheckbox.checked = false;
      }
      logInfo('Extension auto-disabled due to empty URL.');
    }

    const validation = performUrlCheck();
    presetController.updateButtonText(customUrl);

    if (!validation.isValid) {
      handleError(ERROR_TYPES.VALIDATION, `Save aborted: ${validation.message}`);
      showSaveButtonFeedback(saveButton, 'error');
      return;
    }

    saveButton.textContent = localizedSaveLabel(SAVE_FEEDBACK_STATES.saving);
    saveButton.disabled = true;

    try {
      chrome.storage.local.set(
        buildSavePayload({
          customUrl,
          allowUnsafeMode: isUnsafeEnabled,
          extensionChecked: isExtensionEnabled,
          debugLogEnabled: isDebugLogEnabled,
        }),
        () => {
          if (chrome.runtime.lastError) {
            handleError(ERROR_TYPES.STORAGE, `Error saving settings: ${chrome.runtime.lastError.message}`, chrome.runtime.lastError);
            showSaveButtonFeedback(saveButton, 'error');
            saveButton.disabled = false;
            return;
          }

          logInfo('Storage updated, notifying background script...');

          chrome.runtime.sendMessage({ type: "UPDATE_RULES" }, (response) => {
            const success = Boolean(response && response.success);
            logInfo(`Background script ${success ? 'acknowledged' : 'did not acknowledge'} settings update`);

            if (success) {
              showSaveButtonFeedback(saveButton, 'success', !isExtensionEnabled);
            } else {
              // The settings did land in chrome.storage, but the
              // background worker never acknowledged the update
              // (no listener — extension mid-reload — or the
              // message was dropped). Only that ack invalidates
              // the background's settings cache (see
              // UPDATE_RULES in background.js), so the OLD rules
              // stay live until the 15s cache TTL expires. Do not
              // flash success: surface the non-ack as an error so
              // the user knows the new URL may not be active yet
              // (issue #37).
              handleError(ERROR_TYPES.STORAGE,
                'Settings were saved, but the background script did not acknowledge the update; the new rules may not be active yet.');
              showSaveButtonFeedback(saveButton, 'error');
            }

            saveButton.disabled = false;
          });
        }
      );
    } catch (error) {
      handleError(ERROR_TYPES.STORAGE, `Error saving settings: ${error.message || 'Unknown error'}`, error);
      showSaveButtonFeedback(saveButton, 'error');
      saveButton.disabled = false;
    }
  }

  // Core wiring that stays in the orchestrator. The preset picker's and
  // debug pane's listeners are owned by their controllers (see
  // presetController.wireEvents / debugController.wireEvents below).
  function setupEventListeners() {
    if (elements.saveButton) {
      elements.saveButton.addEventListener('click', saveOptions);
    } else {
      logInfo('Warning: Save button not found.');
    }

    if (elements.urlInput) {
      elements.urlInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          performUrlCheck();
          presetController.updateButtonText(elements.urlInput.value);
          saveOptions();
        }
      });

      elements.urlInput.addEventListener('input', () => {
        manageTimeout('urlInputDebounce', () => {}, 0);
        manageTimeout('urlInputDebounce', () => {
          performUrlCheck();
          presetController.updateButtonText(elements.urlInput.value);
        }, INPUT_DEBOUNCE_DELAY);
      });
    } else {
      logInfo('Warning: URL input not found.');
    }

    if (elements.unsafeModeCheckbox) {
      elements.unsafeModeCheckbox.addEventListener('change', () => {
        toggleUnsafeWarning();
        performUrlCheck();
        presetController.updateButtonText(elements.urlInput.value);
      });
    } else {
      logInfo('Warning: Unsafe mode checkbox not found.');
    }

    if (!elements.enableExtensionCheckbox) {
      logInfo('Warning: Enable extension checkbox not found.');
    }

    if (elements.debugLogCheckbox) {
      elements.debugLogCheckbox.addEventListener('change', () => {
        logInfo(`Debug log ${elements.debugLogCheckbox.checked ? 'enabled' : 'disabled'} (saved when the user saves options).`);
      });
    }

    if (elements.toggleAdvancedButton && elements.advancedOptionsContainer) {
      elements.toggleAdvancedButton.addEventListener('click', () => {
        const isExpanded = elements.toggleAdvancedButton.getAttribute('aria-expanded') === 'true';
        elements.advancedOptionsContainer.style.display = isExpanded ? 'none' : 'block';
        elements.toggleAdvancedButton.setAttribute('aria-expanded', String(!isExpanded));
        if (!isExpanded) toggleUnsafeWarning();
      });
    } else {
      logInfo('Warning: Advanced toggle button or container not found.');
    }
  }

  function setupFocus() {
    if (elements.urlInput) elements.urlInput.focus();
  }

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
      if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveOptions();
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
      handleError(ERROR_TYPES.DOM, 'Initialization failed: One or more essential UI elements are missing.');
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

    logInfo('Popup initializing...');
    setupKeyboardShortcuts();
    presetController.wireEvents();
    debugController.wireEvents();
    setupEventListeners();
    restoreOptions();
    setupFocus();
    logInfo('Popup initialized successfully.');
  }

  initializePopup();
});
