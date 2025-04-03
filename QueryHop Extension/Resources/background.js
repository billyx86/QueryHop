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

const searchEngines = [
  { pattern: /^https?:\/\/(?:\w+\.)?google\.[a-z.]+\/search\?.*/, queryParam: "q" },
  { pattern: /^https?:\/\/duckduckgo\.com\/\?.*/, queryParam: "q" },
  { pattern: /^https?:\/\/(?:\w+\.)?bing\.com\/search\?.*/, queryParam: "q" },
  { pattern: /^https?:\/\/(?:\w+\.)?ecosia\.org\/search\?.*/, queryParam: "q" },
  { pattern: /^https?:\/\/(?:\w+\.)?baidu\.com\/s\?.*/, queryParam: ["wd", "word"] },
  { pattern: /^https?:\/\/search\.yahoo\.com\/search\?.*/, queryParam: "p" },
  { pattern: /^https?:\/\/(?:\w+\.)?yandex\.[a-z.]+\/(?:search|search\/)\?.*/, queryParam: "text" }
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
      extensionEnabled: false
    });

    if (typeof items === 'object' && items !== null) {
      settingsCache = items;
      settingsCacheTime = now;
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

  logMessage('log', `Search query detected: "${searchQuery}" on ${matchedEngine.pattern.source}`);
  await redirectTab(details.tabId, targetUrl, originalUrl);
}
