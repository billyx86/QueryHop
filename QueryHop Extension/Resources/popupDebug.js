//
//  popupDebug.js
//  QueryHop Extension
//
// The debug-log pane for the options popup — split out of popup.js in #53.
// The background worker owns the log (chrome.storage.session); this module
// only reads, renders, clears and copies it via runtime messages, and wires
// the refresh / clear / copy buttons.
//
// Entry formatting (incl. the 50-entry view cap and the #19 truncation
// footer) lives in popupRules.js so the exact line shape is unit-tested
// there; the copy button's state machine lives in popupState.js. This module
// is a factory over a shared context (elements, t, logInfo, handleError, ...)
// and keeps only the DOM wiring that needs the live elements.
//
// popup.js composes it: it builds the context, calls createDebugController
// once, and delegates the refresh / clear / copy flows (and their button
// wiring) to the returned controller.

import {
  formatDebugLogViewText,
  formatDebugLogForCopy,
  DEBUG_LOG_EMPTY_TEXT,
} from './popupRules.js';
import {
  COPY_FEEDBACK_STATES,
  nextCopyFeedbackState,
} from './popupState.js';

export function createDebugController(ctx) {
  const { elements, t, logInfo, handleError, ERROR_TYPES, FEEDBACK_DURATION } = ctx;

  // chrome.runtime.sendMessage is callback-based; wrap it in a promise that
  // never rejects (the debug pane degrades gracefully on a failed message).
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

  // popupState.js keeps the English labels (unit-tested there); the i18n key
  // for each state is mapped here so the button renders in the UI language.
  // Unknown labels fall through to the English literal.
  function localCopyLabel(label) {
    if (label === COPY_FEEDBACK_STATES.copied) return t('copy_copied', label);
    if (label === COPY_FEEDBACK_STATES.failed) return t('copy_failed', label);
    if (label === COPY_FEEDBACK_STATES.nothing) return t('copy_nothing', label);
    return t('copy_log', label); // idle
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
  // background worker, to the clipboard for sharing. Falls back to a manual
  // selection (select + document.execCommand) when the async clipboard API is
  // unavailable in the extension context.
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
      // popupState.js; a failed/empty export is reported as a failed read so
      // the label comes out "Nothing to copy" either way.
      const exportResponse = text ? response : null;
      const applyCopyState = (copyResult) => {
        const state = nextCopyFeedbackState(exportResponse, entries.length, hasClipboard, copyResult);
        flash(state.label);
        if (state.log) {
          logInfo(`Debug log copied to clipboard (${entries.length} entries).`);
        }
      };
      if (!text) {
        // Nothing to export (empty log, or the background worker refused the
        // read).
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

  function wireEvents() {
    if (elements.refreshDebugLogBtn) {
      elements.refreshDebugLogBtn.addEventListener('click', () => loadDebugLog());
    }

    if (elements.clearDebugLogBtn) {
      elements.clearDebugLogBtn.addEventListener('click', () => clearDebugLog());
    }

    if (elements.copyDebugLogBtn) {
      elements.copyDebugLogBtn.addEventListener('click', () => copyDebugLog());
    }
  }

  return { loadDebugLog, clearDebugLog, copyDebugLog, wireEvents };
}
