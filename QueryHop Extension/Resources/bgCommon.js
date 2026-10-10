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
// was indistinguishable from routine `log` lines.
const CONSOLE_METHODS = { error: 'error', warn: 'warn' };

// (#92) The single place a log level becomes a console method. Every
// console call site — logMessage, the popup -> worker LOG_MESSAGE relay,
// the popup's sendMessage fallback — goes through here, so an unvalidated
// level (a message-payload field, a caller typo) is never used to index an
// undefined method on console. Unknown levels fall back to `log`.
export function consoleMethodFor(level) {
  return CONSOLE_METHODS[level] || 'log';
}

export function logMessage(type, message, data = null) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [Background]`;
  console[consoleMethodFor(type)](prefix, message, data || '');
}

// Debug-log redaction (#12), moved here from bgDebugLog.js in #91 so the
// console paths — not just the ring buffer — can route through the same
// helpers; bgDebugLog.js re-exports them for the worker's import surface.
// Pure functions (no chrome global), safe in any context.
//
// Parameter names whose values are treated as credentials and redacted from
// logged URLs (#12). Kept deliberately broad: a false positive just hides a
// value the user can look up elsewhere, a false negative leaks a secret.
const SENSITIVE_URL_PARAM_NAMES = [
  'token', 'access_token', 'refreshtoken', 'api_token', 'apitoken',
  'apikey', 'api_key', 'accesskey', 'access_key', 'secretkey', 'secret_key',
  'secret', 'key', 'password', 'passwd', 'pwd', 'auth', 'authorization',
  'sessionid', 'session_id', 'sid', 'ssnid',
  'code', 'oauthcode', 'otp', 'verificationcode', 'verification_code',
  'cookie', 'jsessionid', 'phpsessid', 'cf_eid', 'csrftoken', '_token'
];

// Search-query parameter names (per supported engine + common synonyms).
// The entry's `query` field is already fingerprinted, so leaving q=...
// plaintext in a logged URL would re-leak the search term (#12).
const SEARCH_QUERY_PARAM_NAMES = [
  'q', 'wd', 'word', 'query', 'search', 'searchterm',
  'search_term', 'search_query', 'srch', 'text', 'p'
];

// FNV-1a 64-bit hash -> 8 hex chars. Used for the redacted `query` field:
// deterministic (same search -> same fingerprint, so entries correlate) but
// non-reversible for any realistic search term. A fingerprint, not a digest:
// it is correlation metadata, not a security boundary.
export function fingerprintForLog(value) {
  const s = typeof value === 'string' ? value : String(value == null ? '' : value);
  if (!s) return null;
  let h = 0xcbf29ce484222325n;
  const prime = 0x00000100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0').slice(0, 8);
}

// Replace a logged search term with `n=<len>,fp=<fingerprint>` — enough to
// confirm "the right search was redirected" without storing the term itself.
export function redactQueryForLog(query) {
  if (typeof query !== 'string' || query === '') return '';
  return `n=${query.length},fp=${fingerprintForLog(query)}`;
}

// Redact credential-looking values in a URL for logging (#12). Three
// locations where secrets and search terms live, all replaced with
// [REDACTED] (the parameter name stays, so entries are still readable):
//   1. query params with credential-looking names (token=, key=, sid=, ...)
//      — never persist a potential secret,
//   2. query params with search-query names (q=, wd=, text=, ...) — the
//      entry's `query` field is already fingerprinted, so leaving the term
//      inside a URL would re-leak it (acceptance criterion: no plaintext
//      search term in the ring buffer, not just outside the `query` field),
//   3. (#94) Basic-auth userinfo (user:password@) and fragment params
//      (#access_token=… — OAuth token-in-hash flows): two more locations
//      credentials routinely live, with the same two name classes applied.
// Returns the input unchanged if nothing matched; degrades to best-effort
// redaction for strings `new URL()` rejects (#95).
export function redactSensitiveUrlParams(url) {
  if (typeof url !== 'string' || !url) return url;
  try {
    const u = new URL(url);
    let changed = false;
    u.searchParams.forEach((value, name) => {
      const n = name.toLowerCase();
      if (SENSITIVE_URL_PARAM_NAMES.includes(n) || SEARCH_QUERY_PARAM_NAMES.includes(n)) {
        u.searchParams.set(name, '[REDACTED]');
        changed = true;
      }
    });
    // #94: userinfo — the URL API serializes either field non-empty as
    // "user:pass@", so set both (a username-only credential still carries
    // the account name).
    if (u.username || u.password) {
      u.username = '[REDACTED]';
      u.password = '[REDACTED]';
      changed = true;
    }
    // #94: fragment — parse like a query string and apply the same two
    // name classes (token-in-hash OAuth flows keep the whole fragment).
    if (u.hash) {
      const fragmentParams = new URLSearchParams(u.hash.slice(1));
      let fragmentChanged = false;
      fragmentParams.forEach((value, name) => {
        const n = name.toLowerCase();
        if (SENSITIVE_URL_PARAM_NAMES.includes(n) || SEARCH_QUERY_PARAM_NAMES.includes(n)) {
          fragmentParams.set(name, '[REDACTED]');
          fragmentChanged = true;
        }
      });
      if (fragmentChanged) {
        u.hash = fragmentParams.toString();
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    // #95: `new URL()` rejected the string (a schemeless near-miss) — the
    // exact input class the extractSearchQuery catch path sees. Best-effort
    // redaction below: same name list, applied to whatever looks like a
    // k=v assignment after ?, #, or the start of the string.
    return redactUrlBestEffort(url);
  }
}

// #95 — redaction for strings the URL parser rejects. Same name list as
// the query/fragment paths above; a false positive hides a value, a false
// negative leaks a secret, so this errs broad. Strings with no matches
// come through byte-identical.
const REDACT_URL_PARAM_RE = new RegExp(
  `(^|[?&#])(${[...SENSITIVE_URL_PARAM_NAMES, ...SEARCH_QUERY_PARAM_NAMES].join('|')})=([^&#\\s]+)`,
  'gi'
);

function redactUrlBestEffort(url) {
  if (typeof url !== 'string' || !url) return url;
  return url.replace(REDACT_URL_PARAM_RE, (match, lead, name) => `${lead}${name}=[REDACTED]`);
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

    // #91: the full URL reaches the console — redact credential/query
    // params first (the #12 contract covers the console path, not just
    // the ring buffer).
    logMessage('warn', `Could not find query parameter(s) [${potentialParams.join(', ')}] in URL: ${redactSensitiveUrlParams(url)}`);
    return null;
  } catch (e) {
    // #95: the last unredacted URL site on the console. `url` here is the
    // original navigation URL — the one carrying the plaintext search term
    // (and, on the same class of URL, any credential params). The helper
    // degrades to best-effort redaction for the unparseable strings this
    // catch exists for, so the wrap is effective even where `new URL()`
    // rejects.
    logMessage('error', `${ERROR_TYPES.NAVIGATION}: Failed to extract search query from ${redactSensitiveUrlParams(url)}`, e);
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
      // #91: the term itself must not reach the console either, even on
      // the encode-failure path (encodeURIComponent can throw on lone
      // surrogates).
      logMessage('error', `${ERROR_TYPES.REDIRECT}: Failed to encode search query "${redactQueryForLog(searchQuery)}"`, e);
      return null;
    }
  } else if (allowUnsafeMode) {
    return trimmedCustomUrl;
  } else {
    logMessage('error', `${ERROR_TYPES.VALIDATION}: Invalid configuration: Custom URL is missing '%s' placeholder and Unsafe Mode is disabled.`);
    return null;
  }
}
