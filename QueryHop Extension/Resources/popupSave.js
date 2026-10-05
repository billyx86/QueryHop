//
//  popupSave.js
//  QueryHop Extension
//
// The options save flow — split out of popup.js in #64, same factory-over-a-
// shared-context pattern as popupPreset.js / popupDebug.js (#53). Owns
// saveOptions (read form -> validate -> chrome.storage.local.set ->
// UPDATE_RULES ack) and showSaveButtonFeedback (the label/flash state and
// its timed reset).
//
// The pure decisions stay unit-tested under Node: the save payload
// (buildSavePayload) and the auto-disable rule (shouldAutoDisableExtension)
// in popupState.js, and the button feedback state machine (nextFeedbackState
// over SAVE_FEEDBACK_STATES) in popupState.js. This module keeps only the
// DOM + chrome wiring: it takes the pre-built localized save label
// (makeLocalizedSaveLabel, popupI18n.js) and the shared plumbing from
// createPopupCore.js (timers, logging, storage, performUrlCheck) via ctx.

import {
  SAVE_FEEDBACK_STATES,
  shouldAutoDisableExtension,
  buildSavePayload,
  nextFeedbackState,
} from './popupState.js';

export function createSaveController(ctx) {
  const {
    elements,
    manageTimeout,
    logInfo,
    handleError,
    performUrlCheck,
    localizedSaveLabel,
    updatePresetButtonText,
    ERROR_TYPES,
    FEEDBACK_DURATION,
  } = ctx;

  // Apply one feedback outcome to the save button and schedule the timed
  // reset back to the default label. The label/class decision is the tested
  // state machine in popupState.js; this only applies it and owns the timer.
  function showSaveButtonFeedback(button, type, isDisabledReminder = false) {
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

  function saveOptions() {
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

  // Save-button click + URL-input Enter. The debounced 'input' listener and
  // the Ctrl/Cmd+S shortcut live in popup.js, which wires them to these
  // two functions.
  function wireEvents() {
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
          updatePresetButtonText(elements.urlInput.value);
          saveOptions();
        }
      });
    } else {
      logInfo('Warning: URL input not found.');
    }
  }

  return { saveOptions, showSaveButtonFeedback, wireEvents };
}
