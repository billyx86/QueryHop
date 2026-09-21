//
//  popup.js
//  QueryHop Extension
//
// DOM wiring for the options popup. The pure rules/validation/formatting
// logic lives in popupRules.js (imported below) so it can be unit-tested
// under Node — this file keeps only what needs the DOM and chrome.* APIs:
// element lookups, event handlers, validation caching, storage and
// runtime-message calls.
//
// i18n (#21): user-facing strings resolve through t() — chrome.i18n with an
// English-literal fallback, see popupI18n.js. Static markup is localized
// via the data-i18n* attributes in popup.html (applied in initializePopup);
// dynamic strings (validation status, save/copy feedback, empty-log and
// init-failure text) are localized at their point of use below.

import {
  validateSearchUrl,
  formatDebugLogViewText,
  formatDebugLogForCopy,
  DEBUG_LOG_EMPTY_TEXT,
} from './popupRules.js';
import {
  SAVE_FEEDBACK_STATES,
  COPY_FEEDBACK_STATES,
  DEFAULT_PRESET_BUTTON_TEXT,
  shouldAutoDisableExtension,
  buildSavePayload,
  nextFeedbackState,
  nextCopyFeedbackState,
  presetLabelForUrl,
  presetCloseOnOutsideClick,
} from './popupState.js';
import {
  makeT,
  applyI18n,
} from './popupI18n.js';

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
        copyDebugLogBtn: document.getElementById('copyDebugLog')
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
    
    function localCopyLabel(label) {
        if (label === COPY_FEEDBACK_STATES.copied) return t('copy_copied', label);
        if (label === COPY_FEEDBACK_STATES.failed) return t('copy_failed', label);
        if (label === COPY_FEEDBACK_STATES.nothing) return t('copy_nothing', label);
        return t('copy_log', label); // idle
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
    // Save-button labels, flash classes and the preset default text live in
    // popupState.js (issue #22) so that state machine is unit-tested there;
    // FEEDBACK_DURATION below is only the reset timer.
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
    
    function updatePresetButtonText(currentUrl) {
        if (!elements.presetToggleText || !elements.presetDropdown) return;

        // The label decision (match by data-url, default-text fallback) is
        // pure and unit-tested in popupState.js; this is just DOM wiring.
        const presets = [...elements.presetDropdown.querySelectorAll('.preset-item')].map((item) => ({
            url: item.dataset.url || '',
            name: (item.querySelector('.preset-name')?.textContent || '').trim()
        }));
        const label = presetLabelForUrl(presets, currentUrl);
        // Preset names are product names (not translated); only the
        // "no preset matches" default text is localized.
        elements.presetToggleText.textContent =
            label === DEFAULT_PRESET_BUTTON_TEXT ? t('select_preset', label) : label;
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
    
    // --- Debug log (#8) ------------------------------------------------------
    // The background script owns the log (chrome.storage.session); the popup
    // only reads, renders and clears it via runtime messages.
    function chromeMessageSend(message) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        resolve({ success: false, error: chrome.runtime.lastError.message });
                    } else {
                        resolve(response || { success: false });
                    }
                });
            } catch (error) {
                resolve({ success: false, error: error.message });
            }
        });
    }
    
    // Entry formatting lives in popupRules.js so the exact line shape
    // (incl. the redacted `n=..,fp=..` query from #12/#13) is unit-tested.
    // `entriesDropped` (#19) lets the pane disclose a truncated ring buffer.
    function renderDebugLog(entries, entriesDropped = 0, maxEntries = 200) {
        if (!elements.debugLogView) return;
        const text = formatDebugLogViewText(entries, entriesDropped, maxEntries);
        // The empty-placeholder text is pinned in English in popupRules.js
        // (unit-tested); localize it here at the display boundary.
        elements.debugLogView.textContent =
            text === DEBUG_LOG_EMPTY_TEXT ? t('debug_log_empty', text) : text;
    }
    
    function loadDebugLog() {
        return chromeMessageSend({ type: 'GET_DEBUG_LOG' }).then((response) => {
            if (response && response.success) {
                renderDebugLog(response.entries || [], response.entriesDropped || 0, response.maxEntries || 200);
            } else {
                elements.debugLogView.textContent = t('debug_log_load_failed', 'Could not load the debug log.');
            }
        });
    }
    
    function clearDebugLog() {
        return chromeMessageSend({ type: 'CLEAR_DEBUG_LOG' }).then((response) => {
            if (response && response.success) {
                renderDebugLog([]);
            } else {
                elements.debugLogView.textContent = t('debug_log_clear_failed', 'Could not clear the debug log.');
            }
        });
    }
    
    // #15 — Copy the whole (un-capped) debug log, pre-redacted by the
    // background worker, to the clipboard for sharing. Falls back to a
    // manual selection (select + document.execCommand) when the async
    // clipboard API is unavailable in the extension context.
    function copyDebugLog() {
        if (!elements.copyDebugLogBtn) return;
        const flash = (label) => {
            if (!elements.copyDebugLogBtn) return;
            elements.copyDebugLogBtn.textContent = localCopyLabel(label);
            setTimeout(() => {
                if (elements.copyDebugLogBtn) elements.copyDebugLogBtn.textContent = localCopyLabel(COPY_FEEDBACK_STATES.idle);
            }, FEEDBACK_DURATION);
        };
        const fallbackCopy = (text, onResult) => {
            try {
                const helper = document.createElement('textarea');
                helper.value = text;
                helper.style.position = 'fixed';
                helper.style.opacity = '0';
                document.body.appendChild(helper);
                helper.select();
                const worked = document.execCommand('copy');
                document.body.removeChild(helper);
                onResult(worked ? 'fallback-ok' : 'fallback-failed');
                if (!worked) {
                    handleError(ERROR_TYPES.DOM, 'Copy-log fallback (execCommand) returned false.');
                }
            } catch (error) {
                onResult('fallback-error');
                handleError(ERROR_TYPES.DOM, `Copy-log fallback failed: ${error.message || 'Unknown error'}`, error);
            }
        };
        return chromeMessageSend({ type: 'GET_DEBUG_LOG' }).then((response) => {
            const ok = response && response.success;
            const entries = ok ? (response.entries || []) : [];
            const entriesDropped = ok ? (response.entriesDropped || 0) : 0;
            const maxEntries = ok ? (response.maxEntries || 200) : 200;
            const text = ok ? formatDebugLogForCopy(entries, entriesDropped, maxEntries) : '';
            const hasClipboard = Boolean(navigator.clipboard && navigator.clipboard.writeText);
            // The button state per outcome is the tested state machine in
            // popupState.js; a failed/empty export is reported as a failed
            // read so the label comes out "Nothing to copy" either way.
            const exportResponse = text ? response : null;
            const applyCopyState = (copyResult) => {
                const state = nextCopyFeedbackState(exportResponse, entries.length, hasClipboard, copyResult);
                flash(state.label);
                if (state.log) {
                    logInfo(`Debug log copied to clipboard (${entries.length} entries).`);
                }
            };
            if (!text) {
                // Nothing to export (empty log, or the background worker
                // refused the read).
                applyCopyState('pending');
                return;
            }
            if (hasClipboard) {
                navigator.clipboard.writeText(text).then(
                    () => applyCopyState('ok'),
                    () => fallbackCopy(text, applyCopyState)
                );
            } else {
                fallbackCopy(text, applyCopyState);
            }
        });
    }
    
    function resetToDefaults() {
        if (elements.urlInput) elements.urlInput.value = DEFAULT_SEARCH_URL;
        if (elements.unsafeModeCheckbox) elements.unsafeModeCheckbox.checked = false;
        if (elements.enableExtensionCheckbox) elements.enableExtensionCheckbox.checked = false;
        if (elements.debugLogCheckbox) elements.debugLogCheckbox.checked = false;
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
                extensionEnabled: false,
                debugLogEnabled: false
            });
            
            if (elements.urlInput) elements.urlInput.value = items.customSearchUrl;
            if (elements.unsafeModeCheckbox) elements.unsafeModeCheckbox.checked = items.allowUnsafeMode;
            if (elements.enableExtensionCheckbox) elements.enableExtensionCheckbox.checked = items.extensionEnabled;
            if (elements.debugLogCheckbox) elements.debugLogCheckbox.checked = Boolean(items.debugLogEnabled);
            
            toggleUnsafeWarning();
            performUrlCheck();
            updatePresetButtonText(elements.urlInput.value);
            loadDebugLog();
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
        updatePresetButtonText(customUrl);
        
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
                    debugLogEnabled: isDebugLogEnabled
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
                    const success = response && response.success;
                    logInfo(`Background script ${success ? 'acknowledged' : 'did not acknowledge'} settings update`);
                    
                    showSaveButtonFeedback(saveButton, 'success', !isExtensionEnabled);
                    
                    saveButton.disabled = false;
                });
            });
        } catch (error) {
            handleError(ERROR_TYPES.STORAGE, `Error saving settings: ${error.message || 'Unknown error'}`, error);
            showSaveButtonFeedback(saveButton, 'error');
            saveButton.disabled = false;
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
        
        if (elements.debugLogCheckbox) {
            elements.debugLogCheckbox.addEventListener('change', () => {
                logInfo(`Debug log ${elements.debugLogCheckbox.checked ? 'enabled' : 'disabled'} (saved when the user saves options).`);
            });
        }
        
        if (elements.refreshDebugLogBtn) {
            elements.refreshDebugLogBtn.addEventListener('click', () => loadDebugLog());
        }
        
        if (elements.clearDebugLogBtn) {
            elements.clearDebugLogBtn.addEventListener('click', () => clearDebugLog());
        }
        
        if (elements.copyDebugLogBtn) {
            elements.copyDebugLogBtn.addEventListener('click', () => copyDebugLog());
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
            if (elements.presetDropdown) {
                // The close decision is pure and unit-tested in popupState.js.
                if (presetCloseOnOutsideClick({
                    open: elements.presetDropdown.style.display === 'block',
                    dropdown: elements.presetDropdown,
                    toggleButton: elements.presetToggleBtn,
                    target: event.target
                })) {
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
        setupEventListeners();
        restoreOptions();
        setupFocus();
        logInfo('Popup initialized successfully.');
    }
    
    initializePopup();
});
