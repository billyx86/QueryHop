//
//  popupCore.js
//  QueryHop Extension
//
// The shared plumbing the popup controllers lean on — split out of popup.js
// in #64. Owns the per-boot timeout bookkeeping, the background-log bridge
// (logToBackground / logInfo / handleError), the validation cache in front
// of the pure validator in popupRules.js, the URL-check flow, the
// chrome.storage.local wrapper, and the "generic" control listeners (unsafe
// mode, debug-log toggle, advanced options) that coordinate more than one
// controller.
//
// The pure decisions stay in popupRules.js / popupState.js (unit-tested
// under Node); the validation-message -> i18n-key mapper is passed in
// pre-built (makeLocalizedValidationMessage in popupI18n.js) so this module
// keeps no i18n logic of its own. popup.js builds one instance per boot
// with createPopupCore and hands the returned functions to the save /
// restore / preset / debug controllers as their shared context.

import { validateSearchUrl } from './popupRules.js';

// Save/copy feedback flash reset timer (ms).
export const FEEDBACK_DURATION = 1200;
// Keystroke debounce before the URL check re-runs (ms).
export const INPUT_DEBOUNCE_DELAY = 300;
// Error categories for handleError and the LOG_MESSAGE payload.
export const ERROR_TYPES = Object.freeze({
  STORAGE: 'storage_error',
  VALIDATION: 'validation_error',
  PERMISSION: 'permission_error',
  NETWORK: 'network_error',
  DOM: 'dom_error',
});

export function createPopupCore(ctx) {
  const { elements, localizedValidationMessage } = ctx;

  const timeouts = {
    urlCheck: null,
    saveButtonFeedback: null,
    urlInputDebounce: null,
  };

  const validationCache = {
    lastUrl: null,
    lastUnsafeMode: null,
    result: null,
  };

  // Replace (or clear) the named per-boot timer. duration 0 clears only.
  function manageTimeout(type, callback, duration) {
    if (timeouts[type]) {
      clearTimeout(timeouts[type]);
      timeouts[type] = null;
    }
    if (duration > 0) {
      timeouts[type] = setTimeout(callback, duration);
    }
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

  function logInfo(message, data = null) {
    logToBackground('log', message, data);
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

  // Reads the current form state, runs the (cached) validation, and renders
  // the localized status line. Returns the validation result so callers
  // (the save flow) can branch on it without re-validating.
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

  // Drop the validation cache (used by the reset flow so the next check
  // re-validates instead of replaying a stale result).
  function resetValidationCache() {
    validationCache.lastUrl = null;
    validationCache.lastUnsafeMode = null;
    validationCache.result = null;
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

  // The "generic" controls each coordinate the shared plumbing with the
  // preset button or the save flow, so they live in the core rather than in
  // one controller. `updatePresetButtonText` is injected: the preset
  // controller is built after this core, so the callback closes over it
  // lazily.
  function wireGenericControls(updatePresetButtonText) {
    if (elements.urlInput) {
      elements.urlInput.addEventListener('input', () => {
        manageTimeout('urlInputDebounce', () => {}, 0);
        manageTimeout('urlInputDebounce', () => {
          performUrlCheck();
          updatePresetButtonText(elements.urlInput.value);
        }, INPUT_DEBOUNCE_DELAY);
      });
    }

    if (elements.unsafeModeCheckbox) {
      elements.unsafeModeCheckbox.addEventListener('change', () => {
        toggleUnsafeWarning();
        performUrlCheck();
        updatePresetButtonText(elements.urlInput.value);
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

  return {
    manageTimeout,
    logToBackground,
    logInfo,
    handleError,
    toggleUnsafeWarning,
    setUrlCheckStatus,
    performUrlCheck,
    resetValidationCache,
    chromeStorageGet,
    wireGenericControls,
  };
}
