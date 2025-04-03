//
//  popup.js
//  Safari Search Redirector
//
//  Created by Billy King on 02/04/2025.
//

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
    advancedOptionsContainer: document.getElementById('advancedOptions')
  };

  const DEFAULT_SEARCH_URL = "";
  const DEFAULT_PRESET_BUTTON_TEXT = "Select Preset";
  const SAVE_BUTTON_TEXT = {
    DEFAULT: "Save Options",
    SAVED: "Saved!",
    SAVED_DISABLED: "Saved (Disabled)",
    ERROR: "Error!"
  };
  const FEEDBACK_DURATION = 1200;
  const INPUT_DEBOUNCE_DELAY = 300;
  const ERROR_TYPES = {
    STORAGE: 'storage_error',
    VALIDATION: 'validation_error',
    PERMISSION: 'permission_error',
    NETWORK: 'network_error',
    DOM: 'dom_error'
  };

  const validationCache = {
    lastUrl: null,
    lastUnsafeMode: null,
    result: null
  };

  const timeouts = {
    urlCheck: null,
    saveButtonFeedback: null,
    urlInputDebounce: null
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
          timestamp: new Date().toISOString()
        }
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

  function validateUrl(url, isUnsafeMode) {
    if (url === validationCache.lastUrl && isUnsafeMode === validationCache.lastUnsafeMode && validationCache.result) {
      return validationCache.result;
    }

    const trimmedUrl = url.trim();
    let result;
    
    if (!trimmedUrl) {
      result = {
        isValid: true,
        message: 'Leaving the URL empty will disable redirection',
        type: 'info-empty'
      };
    } else if (!isUnsafeMode) {
      if (!trimmedUrl.includes('%s')) {
        result = {
          isValid: false,
          message: "URL must include %s in place of your query",
          type: 'invalid'
        };
      } else if (!trimmedUrl.toLowerCase().startsWith('http://') &&
                !trimmedUrl.toLowerCase().startsWith('https://')) {
        result = {
          isValid: false,
          message: "URL must start with http(s)://",
          type: 'invalid'
        };
      } else {
        try {
          new URL(trimmedUrl.replace(/%s/g, 'testQuery'));
          result = {
            isValid: true,
            message: "URL format valid",
            type: 'valid'
          };
        } catch (e) {
          result = {
            isValid: false,
            message: "Invalid URL format",
            type: 'invalid'
          };
        }
      }
    } else {
      result = {
        isValid: true,
        message: 'URL validation is disabled',
        type: 'info-bypass'
      };
    }

    validationCache.lastUrl = url;
    validationCache.lastUnsafeMode = isUnsafeMode;
    validationCache.result = result;
    
    return result;
  }

  function updatePresetButtonText(currentUrl) {
    if (!elements.presetToggleText || !elements.presetDropdown) return;

    const presetItems = elements.presetDropdown.querySelectorAll('.preset-item');
    let matchFound = false;

    presetItems.forEach(item => {
      if (item.dataset.url && item.dataset.url === currentUrl) {
        const nameSpan = item.querySelector('.preset-name');
        elements.presetToggleText.textContent = nameSpan ?
          nameSpan.textContent.trim() : DEFAULT_PRESET_BUTTON_TEXT;
        matchFound = true;
      }
    });

    if (!matchFound) {
      elements.presetToggleText.textContent = DEFAULT_PRESET_BUTTON_TEXT;
    }
  }

  function performUrlCheck() {
    if (!elements.urlInput || !elements.unsafeModeCheckbox) {
      return { isValid: false };
    }
    
    const urlValue = elements.urlInput.value;
    const isUnsafe = elements.unsafeModeCheckbox.checked;
    const validation = validateUrl(urlValue, isUnsafe);

    setUrlCheckStatus(validation.message, validation.type);
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

  function chromeStorageSet(data) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  function resetToDefaults() {
    if (elements.urlInput) elements.urlInput.value = DEFAULT_SEARCH_URL;
    if (elements.unsafeModeCheckbox) elements.unsafeModeCheckbox.checked = false;
    if (elements.enableExtensionCheckbox) elements.enableExtensionCheckbox.checked = false;
    if (elements.advancedOptionsContainer) elements.advancedOptionsContainer.style.display = 'none';
    if (elements.toggleAdvancedButton) elements.toggleAdvancedButton.setAttribute('aria-expanded', 'false');
    if (elements.presetDropdown) elements.presetDropdown.style.display = 'none';
    if (elements.presetToggleBtn) elements.presetToggleBtn.setAttribute('aria-expanded', 'false');
    
    validationCache.lastUrl = null;
    validationCache.lastUnsafeMode = null;
    validationCache.result = null;
    
    toggleUnsafeWarning();
    setUrlCheckStatus('');
    updatePresetButtonText('');
  }

  async function restoreOptions() {
    try {
      const items = await chromeStorageGet({
        customSearchUrl: DEFAULT_SEARCH_URL,
        allowUnsafeMode: false,
        extensionEnabled: false
      });
      
      if (elements.urlInput) elements.urlInput.value = items.customSearchUrl;
      if (elements.unsafeModeCheckbox) elements.unsafeModeCheckbox.checked = items.allowUnsafeMode;
      if (elements.enableExtensionCheckbox) elements.enableExtensionCheckbox.checked = items.extensionEnabled;
      
      toggleUnsafeWarning();
      performUrlCheck();
      updatePresetButtonText(elements.urlInput.value);
    } catch (error) {
      handleError(ERROR_TYPES.STORAGE, `Error loading settings: ${error.message || 'Unknown error'}`, error);
      resetToDefaults();
      logToBackground('error', 'Error loading settings shown via console/log.');
    }
  }

  function showSaveButtonFeedback(button, type, isDisabledReminder = false) {
    const originalText = SAVE_BUTTON_TEXT.DEFAULT;
    let feedbackText = originalText;
    let targetClass = '';
    const possibleClasses = ['success-flash', 'error-flash', 'warning-flash'];

    if (type === 'success') {
      feedbackText = isDisabledReminder ? SAVE_BUTTON_TEXT.SAVED_DISABLED : SAVE_BUTTON_TEXT.SAVED;
      targetClass = isDisabledReminder ? 'warning-flash' : 'success-flash';
    } else if (type === 'error') {
      feedbackText = SAVE_BUTTON_TEXT.ERROR;
      targetClass = 'error-flash';
    } else {
      button.textContent = originalText;
      button.classList.remove(...possibleClasses);
      manageTimeout('saveButtonFeedback', () => {}, 0);
      return;
    }

    manageTimeout('saveButtonFeedback', () => {}, 0);
    button.textContent = feedbackText;

    if (button.classList.contains(targetClass)) {
      possibleClasses.forEach(cls => {
        if(cls !== targetClass) button.classList.remove(cls);
      });
    } else {
      button.classList.remove(...possibleClasses);
      void button.offsetHeight;
      button.classList.add(targetClass);
    }

    manageTimeout('saveButtonFeedback', () => {
      button.textContent = originalText;
      button.classList.remove(targetClass);
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
    let isExtensionEnabled = elements.enableExtensionCheckbox.checked;
    
    if (!customUrl.trim()) {
      isExtensionEnabled = false;
      if (elements.enableExtensionCheckbox) {
        elements.enableExtensionCheckbox.checked = false;
      }
      logInfo('Extension auto-disabled due to empty URL.');
    }
    
    const validation = performUrlCheck();
    updatePresetButtonText(customUrl);

    if (!validation.isValid) {
      handleError(ERROR_TYPES.VALIDATION, `Save aborted: ${validation.message}`);
      showSaveButtonFeedback(saveButton, 'error');
      return;
    }
    
    try {
      await chromeStorageSet({
        customSearchUrl: customUrl,
        allowUnsafeMode: isUnsafeEnabled,
        extensionEnabled: isExtensionEnabled
      });
      
      logInfo('Options saved successfully');
      showSaveButtonFeedback(saveButton, 'success', !isExtensionEnabled);
      
      try {
        await chrome.runtime.sendMessage({ type: "UPDATE_RULES" });
      } catch (err) {
        handleError(ERROR_TYPES.NETWORK, 'Failed to message background script.', err);
      }
    } catch (error) {
      handleError(ERROR_TYPES.STORAGE, `Error saving settings: ${error.message || 'Unknown error'}`, error);
      showSaveButtonFeedback(saveButton, 'error');
    }
  }

  function togglePresetDropdown(show) {
    if (!elements.presetDropdown || !elements.presetToggleBtn) return;
    
    const shouldShow = typeof show === 'boolean' ?
      show : elements.presetDropdown.style.display === 'none';
    
    if (shouldShow) {
      elements.presetDropdown.style.display = 'block';
      elements.presetToggleBtn.setAttribute('aria-expanded', 'true');
      
      const firstPreset = elements.presetDropdown.querySelector('.preset-item');
      if (firstPreset) {
        setTimeout(() => firstPreset.focus(), 50);
      }
    } else {
      elements.presetDropdown.style.display = 'none';
      elements.presetToggleBtn.setAttribute('aria-expanded', 'false');
    }
  }

  function setupEventListeners() {
    if (elements.saveButton) {
      elements.saveButton.addEventListener('click', saveOptions);
    } else {
      logInfo('Warning: Save button not found.');
    }

    if (elements.urlInput) {
      elements.urlInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          performUrlCheck();
          updatePresetButtonText(elements.urlInput.value);
          saveOptions();
        }
      });

      elements.urlInput.addEventListener('input', () => {
        manageTimeout('urlInputDebounce', () => {}, 0);
        manageTimeout('urlInputDebounce', () => {
          performUrlCheck();
          updatePresetButtonText(elements.urlInput.value);
        }, INPUT_DEBOUNCE_DELAY);
      });
    } else {
      logInfo('Warning: URL input not found.');
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

    if (elements.presetToggleBtn) {
      elements.presetToggleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        togglePresetDropdown();
      });
      
      elements.presetToggleBtn.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
          event.preventDefault();
          togglePresetDropdown(true);
        }
      });
    } else {
      logInfo('Warning: Preset toggle button not found.');
    }

    if (elements.presetDropdown) {
      elements.presetDropdown.addEventListener('click', (event) => {
        const buttonTarget = event.target.closest('.preset-item');
        if (buttonTarget && buttonTarget.dataset.url) {
          const presetUrl = buttonTarget.dataset.url;
          if (elements.urlInput) {
            elements.urlInput.value = presetUrl;
            logInfo(`Preset applied: ${buttonTarget.textContent.trim()}`);
            performUrlCheck();
            updatePresetButtonText(presetUrl);
            togglePresetDropdown(false);
            elements.urlInput.focus();
          }
        }
      });
      
      elements.presetDropdown.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          togglePresetDropdown(false);
          elements.presetToggleBtn?.focus();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          const currentItem = document.activeElement;
          if (currentItem && currentItem.classList.contains('preset-item')) {
            const nextItem = currentItem.nextElementSibling;
            if (nextItem) nextItem.focus();
          }
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          const currentItem = document.activeElement;
          if (currentItem && currentItem.classList.contains('preset-item')) {
            const prevItem = currentItem.previousElementSibling;
            if (prevItem) {
              prevItem.focus();
            } else {
              togglePresetDropdown(false);
              elements.presetToggleBtn?.focus();
            }
          }
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          document.activeElement.click();
        }
      });
    } else {
      logInfo('Warning: Preset dropdown container not found.');
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

    document.addEventListener('click', (event) => {
      if (elements.presetDropdown && elements.presetDropdown.style.display === 'block') {
        if (!elements.presetDropdown.contains(event.target) &&
            !elements.presetToggleBtn.contains(event.target)) {
          togglePresetDropdown(false);
        }
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (elements.presetDropdown && elements.presetDropdown.style.display === 'block') {
          togglePresetDropdown(false);
          elements.presetToggleBtn?.focus();
        }
      }
    });
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
      elements.presetToggleText
    ];
    
    if (essentialElements.some(el => !el)) {
      handleError(ERROR_TYPES.DOM, 'Initialization failed: One or more essential UI elements are missing.');
      document.body.innerHTML = '<p style="color: red; padding: 1em;">Error: Could not initialize popup UI.</p>';
      return;
    }
    
    logInfo('Popup initializing...');
    setupKeyboardShortcuts();
    setupEventListeners();
    restoreOptions();
    setupFocus();
    logInfo('Popup initialized successfully.');
  }

  initializePopup();
});
