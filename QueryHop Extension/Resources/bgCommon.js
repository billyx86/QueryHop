//
//  bgCommon.js
//  QueryHop Extension
//
// Shared pure data + helpers for the background service worker (#50).
// Everything in this module is free of the `chrome` global: the search
// engine patterns, the blocked-scheme denylist, URL construction, and the
// debug-log redaction/formatting helpers. background.js composes these
// into the event wiring; the popup keeps its own copies in popupRules.js.
//
// Keep BLOCKED_SCHEMES, isBlockedScheme and searchEngines byte-stable in
// shape — the drift guards in tests/blocked-schemes-consistency.test.js,
// tests/engine-presets-consistency.test.js, tests/engine-permissions-sync.test.js
// and tests/manifest-consistency.test.js parse this file as text and expect
// these definitions to be visible here (background.js re-exports them).

export const DEFAULT_SEARCH_URL = "";
export const ERROR_TYPES = {
  STORAGE: 'storage_error',
  VALIDATION: 'validation_error',
  NAVIGATION: 'navigation_error',
  REDIRECT: 'redirect_error'
};

// (#89) Level -> console-method map. Only `error` was honoured before —
// `warn` (and everything else) collapsed onto `console.log`, so in a
// service-worker console a genuinely degraded path logged at `warn`
// (engine URL-shape drift, a renamed query param, an identical-URL abort)
// was indistinguishable from routine `log` lines. Unknown levels fall back
// to `log`; never `console[undefined]`.
const CONSOLE_METHODS = { error: 'error', warn: 'warn' };

export function logMessage(type, message, data = null) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [Background]`;
  console[CONSOLE_METHODS[type] || 'log'](prefix, message, data || '');
}

// URL schemes that must never be navigated to, even when the user has opted
// into "unsafe mode". These are code-injection / extension-privilege
// primitives, not legitimate "formats" for a search redirect target.
export const BLOCKED_SCHEMES = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'chrome-extension:',
  'safari-web-extension:',
  'about:',
  'view-source:'
];

export function isBlockedScheme(url) {
  const lower = (url || '').trim().toLowerCase();
  return BLOCKED_SCHEMES.some(scheme => lower.startsWith(scheme));
}

export const searchEngines = [
  { pattern: /^https?:\/\/(?:\w+\.)?google\.(com|co\.uk|de|fr|ca|com\.au|com\.br|co\.in|co\.jp|es|it|nl)\/search\?.*/, queryParam: "q", name: "Google" },
  { pattern: /^https?:\/\/duckduckgo\.com\/\?.*/, queryParam: "q", name: "DuckDuckGo" },
  { pattern: /^https?:\/\/(?:\w+\.)?bing\.com\/search\?.*/, queryParam: "q", name: "Bing" },
  { pattern: /^https?:\/\/(?:\w+\.)?ecosia\.org\/search\?.*/, queryParam: "q", name: "Ecosia" },
  { pattern: /^https?:\/\/(?:\w+\.)?baidu\.com\/s\?.*/, queryParam: ["wd", "word"], name: "Baidu" },
  { pattern: /^https?:\/\/search\.yahoo\.com\/search\?.*/, queryParam: "p", name: "Yahoo" },
  { pattern: /^https?:\/\/(?:\w+\.)?yandex\.(ru|kz|by|com|com\.tr)\/(?:search|search\/)\?.*/, queryParam: "text", name: "Yandex" }
];

export function validateUrl(url, isUnsafeMode) {
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
    } catch {
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

export function extractSearchQuery(url, engine) {
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

export function createTargetUrl(customSearchUrl, searchQuery, allowUnsafeMode) {
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
