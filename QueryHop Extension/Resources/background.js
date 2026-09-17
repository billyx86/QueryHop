//
//  background.js
//  QueryHop Extension
//

const DEFAULT_SEARCH_URL = "";
const ERROR_TYPES = {
  STORAGE: 'storage_error',
  VALIDATION: 'validation_error',
  NAVIGATION: 'navigation_error',
  REDIRECT: 'redirect_error'
};

let settingsCache = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 15000;

// ---------------------------------------------------------------------------
// Debug log (#8)
//
// A lightweight, opt-in ring buffer that records what the extension did with
// each search: which engine matched, whether unsafe mode was active, and any
// blocked-scheme attempts the denylist rejected. It exists because the
// extension otherwise rewrites search URLs silently, with no way to tell
// what matched or why a redirect (or refusal) happened.
//
// Privacy: entries live in chrome.storage.session (cleared when the browser
// exits), are never sent anywhere, and are only recorded at all while the
// user has the "Record debug log" option enabled. Blocked-scheme refusals are
// additionally mirrored to the console unconditionally — those are the
// code-injection attempts worth seeing even without the opt-in log.
// ---------------------------------------------------------------------------
const DEBUG_LOG_KEY = 'queryhopDebugLog';
const DEBUG_LOG_MAX_ENTRIES = 200;
const DEBUG_LOG_URL_LIMIT = 200;
let debugLogEnabled = false;

function truncateForLog(value, limit = DEBUG_LOG_URL_LIMIT) {
  const s = typeof value === 'string' ? value : String(value == null ? '' : value);
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

async function appendDebugLog(event, details) {
  if (!debugLogEnabled) return;
  const entry = {
    time: new Date().toISOString(),
    event,
    ...(details || {})
  };
  // Console mirror (within the opt-in) so the log is visible in the service
  // worker devtools even if the storage write fails.
  console.log('[QueryHop debug]', entry);
  try {
    const items = await chromeStorageSessionGet({ [DEBUG_LOG_KEY]: [] });
    const log = Array.isArray(items[DEBUG_LOG_KEY]) ? items[DEBUG_LOG_KEY] : [];
    log.push(entry);
    while (log.length > DEBUG_LOG_MAX_ENTRIES) log.shift();
    await chromeStorageSessionSet({ [DEBUG_LOG_KEY]: log });
  } catch (error) {
    logMessage('warn', `debug log: failed to persist entry (${error.message})`);
  }
}

async function clearDebugLog() {
  try {
    await chromeStorageSessionSet({ [DEBUG_LOG_KEY]: [] });
  } catch (error) {
    logMessage('warn', `debug log: failed to clear (${error.message})`);
  }
}

async function readDebugLog() {
  try {
    const items = await chromeStorageSessionGet({ [DEBUG_LOG_KEY]: [] });
    return Array.isArray(items[DEBUG_LOG_KEY]) ? items[DEBUG_LOG_KEY] : [];
  } catch (error) {
    logMessage('warn', `debug log: failed to read (${error.message})`);
    return [];
  }
}

// Same shape as chromeStorageGet but for chrome.storage.session — the
// debug log's home. Session storage is wiped when the browser exits, which
// is exactly the retention we want for a local-only debug trail. Falls back
// to a no-op if the runtime lacks the API (Safari web extensions expose it
// alongside the "storage" permission this extension already declares).
function chromeStorageSessionGet(keys) {
  if (!chrome.storage.session || typeof chrome.storage.session.get !== 'function') {
    return Promise.resolve({});
  }
  return new Promise((resolve, reject) => {
    chrome.storage.session.get(keys, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(items);
      }
    });
  });
}

function chromeStorageSessionSet(data) {
  if (!chrome.storage.session || typeof chrome.storage.session.set !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    chrome.storage.session.set(data, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

// URL schemes that must never be navigated to, even when the user has opted
// into "unsafe mode". These are code-injection / extension-privilege
// primitives, not legitimate "formats" for a search redirect target.
const BLOCKED_SCHEMES = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'chrome-extension:',
  'safari-web-extension:',
  'about:',
  'view-source:'
];

function isBlockedScheme(url) {
  const lower = (url || '').trim().toLowerCase();
  return BLOCKED_SCHEMES.some(scheme => lower.startsWith(scheme));
}

const searchEngines = [
  { pattern: /^https?:\/\/(?:\w+\.)?google\.(com|co\.uk|de|fr|ca|com\.au|com\.br|co\.in|co\.jp|es|it|nl)\/search\?.*/, queryParam: "q", name: "Google" },
  { pattern: /^https?:\/\/duckduckgo\.com\/\?.*/, queryParam: "q", name: "DuckDuckGo" },
  { pattern: /^https?:\/\/(?:\w+\.)?bing\.com\/search\?.*/, queryParam: "q", name: "Bing" },
  { pattern: /^https?:\/\/(?:\w+\.)?ecosia\.org\/search\?.*/, queryParam: "q", name: "Ecosia" },
  { pattern: /^https?:\/\/(?:\w+\.)?baidu\.com\/s\?.*/, queryParam: ["wd", "word"], name: "Baidu" },
  { pattern: /^https?:\/\/search\.yahoo\.com\/search\?.*/, queryParam: "p", name: "Yahoo" },
  { pattern: /^https?:\/\/(?:\w+\.)?yandex\.(ru|kz|by|com|com\.tr)\/(?:search|search\/)\?.*/, queryParam: "text", name: "Yandex" }
];

function logMessage(type, message, data = null) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [Background]`;
  console[type === 'error' ? 'error' : 'log'](prefix, message, data || '');
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

async function getSettings() {
  const now = Date.now();
  if (settingsCache && (now - settingsCacheTime < SETTINGS_CACHE_TTL)) {
    return settingsCache;
  }

  try {
    const items = await chromeStorageGet({
      customSearchUrl: DEFAULT_SEARCH_URL,
      allowUnsafeMode: false,
      extensionEnabled: false,
      debugLogEnabled: false
    });

    if (typeof items === 'object' && items !== null) {
      settingsCache = items;
      settingsCacheTime = now;
      debugLogEnabled = Boolean(items.debugLogEnabled);
      return items;
    }

    logMessage('error', `${ERROR_TYPES.STORAGE}: Unexpected return value from storage.local.get`);
    return null;
  } catch (error) {
    logMessage('error', `${ERROR_TYPES.STORAGE}: Failed to get settings from storage`, error);
    return null;
  }
}

function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheTime = 0;
}

function validateUrl(url, isUnsafeMode) {
  const trimmedUrl = url ? url.trim() : "";
  
  if (!trimmedUrl) {
    return {
      isValid: true,
      message: "Empty URL will disable redirection",
      type: 'info'
    };
  }
  
  if (!isUnsafeMode) {
    if (!trimmedUrl.includes('%s')) {
      return {
        isValid: false,
        message: "URL must include %s placeholder in safe mode",
        type: 'invalid'
      };
    }

    if (!trimmedUrl.toLowerCase().startsWith('http://') &&
        !trimmedUrl.toLowerCase().startsWith('https://')) {
      return {
        isValid: false,
        message: "URL must start with http:// or https:// in safe mode",
        type: 'invalid'
      };
    }

    try {
      new URL(trimmedUrl.replace(/%s/g, 'testQuery'));
      return {
        isValid: true,
        message: "URL is valid",
        type: 'valid'
      };
    } catch (e) {
      return {
        isValid: false,
        message: "Invalid URL format",
        type: 'invalid'
      };
    }
  } else {
    // Unsafe mode relaxes the http/https + %s requirements, but never the
    // scheme denylist — those are injection primitives, not "formats".
    if (isBlockedScheme(trimmedUrl)) {
      return {
        isValid: false,
        message: 'URL scheme is not allowed, even in unsafe mode',
        type: 'invalid'
      };
    }
    return {
      isValid: true,
      message: 'URL validation bypassed in unsafe mode',
      type: 'info'
    };
  }
}

function extractSearchQuery(url, engine) {
  try {
    const urlObject = new URL(url);
    const urlParams = urlObject.searchParams;
    const potentialParams = Array.isArray(engine.queryParam) ?
      engine.queryParam : [engine.queryParam];

    for (const param of potentialParams) {
      if (urlParams.has(param)) {
        return urlParams.get(param);
      }
    }
    
    const hash = urlObject.hash.substring(1);
    if (hash) {
      const hashParams = new URLSearchParams(hash);
      for (const param of potentialParams) {
        if (hashParams.has(param)) {
          return hashParams.get(param);
        }
      }
    }

    logMessage('warn', `Could not find query parameter(s) [${potentialParams.join(', ')}] in URL: ${url}`);
    return null;
  } catch (e) {
    logMessage('error', `${ERROR_TYPES.NAVIGATION}: Failed to extract search query from ${url}`, e);
    return null;
  }
}

function createTargetUrl(customSearchUrl, searchQuery, allowUnsafeMode) {
  const trimmedCustomUrl = customSearchUrl ? customSearchUrl.trim() : "";
  
  if (!trimmedCustomUrl) {
    return null;
  }

  if (trimmedCustomUrl.includes('%s')) {
    try {
      return trimmedCustomUrl.replace(/%s/g, encodeURIComponent(searchQuery));
    } catch (e) {
      logMessage('error', `${ERROR_TYPES.REDIRECT}: Failed to encode search query "${searchQuery}"`, e);
      return null;
    }
  } else if (allowUnsafeMode) {
    return trimmedCustomUrl;
  } else {
    logMessage('error', `${ERROR_TYPES.VALIDATION}: Invalid configuration: Custom URL is missing '%s' placeholder and Unsafe Mode is disabled.`);
    return null;
  }
}

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
      sendResponse({ success: true, entries });
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

// Exported for the unit tests in tests/background.test.js. The manifest
// declares the service worker as a module ("type": "module"), so this has
// no runtime effect — it only lets Node's test runner import the pure
// redirect/validation logic for testing.
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
  truncateForLog
};
