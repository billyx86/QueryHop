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
  redactBlockedUrl,
  searchEngines,
  validateUrl,
  extractSearchQuery,
  createTargetUrl,
  logMessage,
  consoleMethodFor
} from './bgCommon.js';
import { getSettings, invalidateSettingsCache, SETTINGS_KEYS } from './bgSettings.js';
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
      // #91: originalUrl is a matched search URL — redact the query/
      // credential params before the full URL reaches the console.
      logMessage('warn', `Target URL is identical to original URL, aborting redirect: ${redactSensitiveUrlParams(targetUrl)}`);
      return false;
    }

    // Final sink guard: refuse to navigate to a blocked scheme no matter how
    // the target URL was produced (settings race, future code path, ...).
    if (isBlockedScheme(targetUrl)) {
      logMessage('error', `${ERROR_TYPES.REDIRECT}: Refusing to navigate to a blocked URL scheme`);
      // These are code-injection attempts (the PR #5 denylist in action).
      // Surface them on the console even without the opt-in debug log, and
      // record them in the ring buffer when the user has logging enabled.
      // The target's body can carry the substituted search term (a `%s`
      // template like `javascript:alert(%s)` becomes `javascript:alert(<term>)`),
      // and param-level redaction can't reach an opaque scheme-specific body —
      // so fingerprint it via redactBlockedUrl, which keeps the scheme as the
      // security signal but strips the body (#12 contract, both sinks).
      console.warn('[QueryHop] BLOCKED redirect target (denied scheme):', truncateForLog(redactBlockedUrl(targetUrl)));
      void appendDebugLog('blocked_scheme', {
        originalUrl: truncateForLog(originalUrl),
        targetUrl: truncateForLog(targetUrl)
      });
      return false;
    }

    await chrome.tabs.update(tabId, { url: targetUrl });
    // #91: the 70-char prefixes routinely carry the plaintext search term
    // (the query starts at ~char 35–45 of a search URL); redact both URLs
    // before they reach the console.
    logMessage('log', `Redirecting Tab ${tabId}: ${truncateForLog(redactSensitiveUrlParams(originalUrl))} -> ${truncateForLog(redactSensitiveUrlParams(targetUrl))}`);
    return true;
  } catch (error) {
    logMessage('error', `${ERROR_TYPES.REDIRECT}: Failed to redirect tab ${tabId} to ${truncateForLog(redactSensitiveUrlParams(targetUrl))}`, error);
    return false;
  }
}

const pendingNavigations = new Map();

// NOTE (#77): this onBeforeNavigate listener is registered with NO `url`
// filter on purpose. It used to be passed a second argument — a `url` filter
// built from the engine regex sources — but that filter was malformed: its
// entries were not the MatchPattern *strings* that chrome.webNavigation's
// `url` filter actually expects (they used a key chrome.webNavigation does not
// recognise), so the filter never matched and the redirect may never have
// fired in a real browser. handleNavigation() below does the authoritative
// searchEngines regex match on every top-frame navigation, so the filter was
// only an (incorrect) optimization. Deriving valid MatchPatterns from the
// regexes would add a third surface that must stay in lockstep with the regexes
// and host_permissions — exactly the drift this repo's other guards exist to
// prevent — so the filter is dropped instead.
// tests/navigation-filter-consistency.test.js guards against reintroducing it.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
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
});

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
      // #91: originalUrl is a search URL (we just matched an engine) —
      // redact the query/credential params before the full URL is logged.
      logMessage('log', `Target URL is same as original, skipping redirect: ${redactSensitiveUrlParams(originalUrl)}`);
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

  // #91: the detected term is the contract violation — the ring-buffer
  // entry above is fingerprinted, but this line fired the plaintext to
  // the console on every redirect. Route through the same redaction
  // helper the buffer uses.
  logMessage('log', `Search query detected: "${redactQueryForLog(searchQuery)}" on ${matchedEngine.pattern.source}`);
  await redirectTab(details.tabId, targetUrl, originalUrl);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !SETTINGS_KEYS.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) return;
  invalidateSettingsCache();
});

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
    // #92: the relay is a boundary — `level` is an unvalidated
    // message-payload field. Route it through consoleMethodFor so an
    // unknown level can never index an undefined method on console
    // (the #89 class of bug, at the boundary).
    const consoleMethod = consoleMethodFor(level);

    if (data && data !== 'null') {
      try {
        const parsedData = JSON.parse(data);
        console[consoleMethod](formattedMessage, logText, parsedData);
      } catch {
        console[consoleMethod](formattedMessage, logText, data);
      }
    } else {
      console[consoleMethod](formattedMessage, logText);
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
  redactBlockedUrl,
  redactDebugEntry,
  DEBUG_LOG_MAX_ENTRIES
};
