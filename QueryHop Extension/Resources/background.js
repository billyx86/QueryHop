//
//  background.js
//  QueryHop Extension
//
// Entry point of the service worker — event wiring only (#50). The logic was
// split into three sibling modules that this file composes:
//
//   bgCommon.js    — shared pure data + helpers (no chrome global):
//                    searchEngines, BLOCKED_SCHEMES, isBlockedScheme,
//                    validateUrl, extractSearchQuery, createTargetUrl,
//                    logMessage
//   bgSettings.js  — TTL-cached chrome.storage.local settings access
//                    (+ the debugLogEnabled flag it syncs)
//   bgDebugLog.js  — opt-in redacted debug log (ring buffer in
//                    chrome.storage.session, #8/#12)
//
// The manifest declares this file as a module ("type": "module"), so the
// sibling imports resolve at worker startup. Everything below is event
// wiring: the debounced navigation handler, the redirect sink guard, and
// the popup message protocol.

import {
  ERROR_TYPES,
  BLOCKED_SCHEMES,
  isBlockedScheme,
  searchEngines,
  validateUrl,
  extractSearchQuery,
  createTargetUrl,
  logMessage
} from './bgCommon.js';
import { getSettings, invalidateSettingsCache } from './bgSettings.js';
import {
  appendDebugLog,
  clearDebugLog,
  readDebugLog,
  readDebugLogDroppedCount,
  truncateForLog,
  fingerprintForLog,
  redactQueryForLog,
  redactSensitiveUrlParams,
  redactDebugEntry,
  DEBUG_LOG_MAX_ENTRIES
} from './bgDebugLog.js';

async function redirectTab(tabId, targetUrl, originalUrl) {
  try {
    if (targetUrl === originalUrl) {
      logMessage('warn', `Target URL is identical to original URL, aborting redirect: ${targetUrl}`);
      return false;
    }

    // Final sink guard: refuse to navigate to a blocked scheme no matter how
    // the target URL was produced (settings race, future code path, ...).
    if (isBlockedScheme(targetUrl)) {
      logMessage('error', `${ERROR_TYPES.REDIRECT}: Refusing to navigate to a blocked URL scheme`);
      // These are code-injection attempts (the PR #5 denylist in action).
      // Surface them on the console even without the opt-in debug log, and
      // record them in the ring buffer when the user has logging enabled.
      console.warn('[QueryHop] BLOCKED redirect target (denied scheme):', truncateForLog(targetUrl));
      void appendDebugLog('blocked_scheme', {
        originalUrl: truncateForLog(originalUrl),
        targetUrl: truncateForLog(targetUrl)
      });
      return false;
    }

    await chrome.tabs.update(tabId, { url: targetUrl });
    logMessage('log', `Redirecting Tab ${tabId}: ${originalUrl.substring(0, 70)}... -> ${targetUrl.substring(0, 70)}...`);
    return true;
  } catch (error) {
    logMessage('error', `${ERROR_TYPES.REDIRECT}: Failed to redirect tab ${tabId} to ${targetUrl.substring(0, 70)}...`, error);
    return false;
  }
}

let pendingNavigations = new Map();

chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return;

    if (pendingNavigations.has(details.tabId)) {
      clearTimeout(pendingNavigations.get(details.tabId));
      pendingNavigations.delete(details.tabId);
    }

    const timeoutId = setTimeout(async () => {
      try {
        await handleNavigation(details);
      } catch (e) {
        logMessage('error', `Error handling navigation: ${e.message}`, e);
      } finally {
        pendingNavigations.delete(details.tabId);
      }
    }, 5);

    pendingNavigations.set(details.tabId, timeoutId);
  },
  {
    url: searchEngines.map(engine => ({ urlMatches: engine.pattern.source }))
  }
);

async function handleNavigation(details) {
  const settings = await getSettings();
  if (!settings || !settings.extensionEnabled || !settings.customSearchUrl) return;

  const originalUrl = details.url;
  let searchQuery = null;
  let matchedEngine = null;

  for (const engine of searchEngines) {
    if (engine.pattern.test(originalUrl)) {
      matchedEngine = engine;
      searchQuery = extractSearchQuery(originalUrl, engine);
      if (searchQuery) break;
    }
  }

  if (!matchedEngine || !searchQuery || searchQuery.trim() === "") return;

  const { customSearchUrl, allowUnsafeMode } = settings;
  const targetUrl = createTargetUrl(customSearchUrl, searchQuery, allowUnsafeMode);

  if (!targetUrl || targetUrl === originalUrl) {
    if (targetUrl === originalUrl) {
      logMessage('log', `Target URL is same as original, skipping redirect: ${originalUrl}`);
    }
    return;
  }

  // Debug log: what engine matched, whether unsafe mode is active, and the
  // final URL the tab is about to navigate to (issue #8).
  void appendDebugLog('redirect', {
    engine: matchedEngine.name,
    enginePattern: matchedEngine.pattern.source,
    query: truncateForLog(searchQuery),
    unsafeMode: Boolean(allowUnsafeMode),
    originalUrl: truncateForLog(originalUrl),
    targetUrl: truncateForLog(targetUrl)
  });

  logMessage('log', `Search query detected: "${searchQuery}" on ${matchedEngine.pattern.source}`);
  await redirectTab(details.tabId, targetUrl, originalUrl);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "UPDATE_RULES") {
    logMessage('log', 'Received settings update notification from popup');
    invalidateSettingsCache();
    sendResponse({ success: true });
    return true;
  }

  // The debug log is read and cleared from the popup's advanced settings.
  if (message?.type === "GET_DEBUG_LOG") {
    void (async () => {
      const entries = await readDebugLog();
      const entriesDropped = await readDebugLogDroppedCount();
      sendResponse({ success: true, entries, entriesDropped, maxEntries: DEBUG_LOG_MAX_ENTRIES });
    })();
    return true; // async response
  }

  if (message?.type === "CLEAR_DEBUG_LOG") {
    void (async () => {
      await clearDebugLog();
      sendResponse({ success: true });
    })();
    return true; // async response
  }

  if (message?.type === "LOG_MESSAGE" && message.payload) {
    const { level, message: logText, data, source, timestamp } = message.payload;
    const formattedMessage = `[${timestamp}] [${source}]`;

    if (data && data !== 'null') {
      try {
        const parsedData = JSON.parse(data);
        console[level || 'log'](formattedMessage, logText, parsedData);
      } catch (e) {
        console[level || 'log'](formattedMessage, logText, data);
      }
    } else {
      console[level || 'log'](formattedMessage, logText);
    }

    return false;
  }

  return false;
});

// Re-exported for the unit tests in tests/background.test.js. The worker
// itself only needs the imported bindings above; the export list exists so
// the test runner can exercise every piece of the composed redirect core
// through one module.
export {
  validateUrl,
  isBlockedScheme,
  createTargetUrl,
  extractSearchQuery,
  getSettings,
  invalidateSettingsCache,
  redirectTab,
  handleNavigation,
  searchEngines,
  BLOCKED_SCHEMES,
  appendDebugLog,
  clearDebugLog,
  readDebugLog,
  readDebugLogDroppedCount,
  truncateForLog,
  fingerprintForLog,
  redactQueryForLog,
  redactSensitiveUrlParams,
  redactDebugEntry,
  DEBUG_LOG_MAX_ENTRIES
};
