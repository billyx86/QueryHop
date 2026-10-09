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

// Redact credentials in a URL for logging (#12). Two strategies, one
// contract (no plaintext secret/term on any path):
//
//   Parseable URL — three locations, all replaced with [REDACTED] (or
//   dropped, for userinfo — the parameter name stays for query params, so
//   entries remain readable):
//     1. userinfo (`https://user:pass@host/`) — Basic-auth credentials;
//        the whole userinfo is dropped (u.username = '' also clears the
//        password and the @ separator), and
//     2. query-string parameters — two classes: credential-looking names
//        (token=, key=, code=, sid=, ...) are never persisted, and
//        search-query names (q=, wd=, text=, ...) are redacted because the
//        entry's `query` field is already fingerprinted, so leaving the
//        term inside a URL would re-leak it (acceptance criterion: no
//        plaintext search term in the ring buffer, not just outside the
//        `query` field),
//     3. fragment (`#access_token=...`) — OAuth-style token-in-hash flows
//        keep credentials in the URL fragment, which URL.searchParams never
//        sees; it gets the same parameter-name treatment as the query string.
//
//   Unparseable URL (#95) — `new URL()` threw, so the param dance above is
//   unavailable. Rather than return the raw string (which is exactly how a
//   malformed search URL carrying its `q=` term reached the console on the
//   extractSearchQuery catch path), fall back to a best-effort regex that
//   redacts the same sensitive/query param names wherever they sit at a
//   real param boundary (? / & / #). Broad by design, matching the
//   parseable path's "false positive hides a value, false negative leaks
//   a secret" stance.
// Returns the input unchanged if nothing matched (or it is not a string).
export function redactSensitiveUrlParams(url) {
  if (typeof url !== 'string' || !url) return url;
  try {
    const u = new URL(url);
    let changed = false;
    if (u.username !== '' || u.password !== '') {
      // Clearing the password also strips the @ separator.
      u.password = '';
      u.username = '';
      changed = true;
    }
    u.searchParams.forEach((value, name) => {
      const n = name.toLowerCase();
      if (SENSITIVE_URL_PARAM_NAMES.includes(n) || SEARCH_QUERY_PARAM_NAMES.includes(n)) {
        u.searchParams.set(name, '[REDACTED]');
        changed = true;
      }
    });
    // The fragment is opaque to URL.searchParams — an OAuth
    // `#access_token=...` hash is parsed manually and given the same
    // treatment. Fragments without '=' (plain anchors like `#section-2`)
    // re-serialize byte-identically, so the no-op path stays untouched.
    if (u.hash) {
      const hashParams = new URLSearchParams(u.hash.slice(1));
      let hashChanged = false;
      hashParams.forEach((value, name) => {
        const n = name.toLowerCase();
        if (SENSITIVE_URL_PARAM_NAMES.includes(n) || SEARCH_QUERY_PARAM_NAMES.includes(n)) {
          hashParams.set(name, '[REDACTED]');
          hashChanged = true;
        }
      });
      if (hashChanged) {
        u.hash = hashParams.toString();
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    // Unparseable: new URL() threw. Do a best-effort raw-string redaction
    // of the same param names at param boundaries instead of leaking the
    // raw input (the #95 catch-path leak).
    return redactUnparseableUrl(url);
  }
}

// Raw-string fallback for the unparseable-URL case (#95). For each
// sensitive/query param name, replace the value of any `<boundary><name>=`
// occurrence (value runs to the next &, #, or end-of-string) with
// [REDACTED]. The original name's case is preserved; the boundary char
// (? / & / #) is required, so `q=` inside a path segment never matches —
// only a genuine query/fragment param does. No match -> input unchanged.
function redactUnparseableUrl(url) {
  const names = [...SENSITIVE_URL_PARAM_NAMES, ...SEARCH_QUERY_PARAM_NAMES];
  let out = url;
  for (const name of names) {
    const re = new RegExp('([?&#])(' + name + ')=([^&#]*)', 'gi');
    out = out.replace(re, (_m, boundary, matchedName) => `${boundary}${matchedName}=[REDACTED]`);
  }
  return out;
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

// Redact a URL bound for a log sink, where that URL is a (or may be a)
// BLOCKED-scheme URL. `redactSensitiveUrlParams` can only strip credential
// query params, userinfo, and fragment — the places a parseable URL keeps
// data. But a blocked-scheme "URL" like `javascript:alert(<term>)` or
// `data:text/html,<script>…(<term>)…</script>` is opaque: `new URL()` parses
// its scheme-specific body as an opaque path with no query or fragment, so a
// term substituted into a `%s` template hides in the body, not a param, and
// survives param-level redaction (the blocked-scheme sink leak). This helper
// keeps the scheme — the security signal a blocked attempt is worth surfacing —
// and replaces the whole body with a length + FNV-1a fingerprint, the same #12
// treatment the query gets. Non-blocked URLs fall through to
// `redactSensitiveUrlParams`, so the helper is total and safe at any sink.
export function redactBlockedUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  const trimmed = url.trim();
  if (!isBlockedScheme(trimmed)) return redactSensitiveUrlParams(url);
  const ci = trimmed.indexOf(':');
  const scheme = trimmed.slice(0, ci + 1);
  const body = trimmed.slice(ci + 1);
  if (!body) return scheme; // e.g. a bare `javascript:` — nothing to redact
  // Idempotency: the body is already our `[blocked-body …]` marker (this URL
  // was redacted once) — return it unchanged rather than fingerprinting the
  // marker, which would drift (n/fp change on every pass). The ring buffer
  // re-serializes through redactSensitiveUrlParams and a second redact pass
  // must be a no-op.
  if (/^\[blocked-body n=\d+,fp=[0-9a-f]{8}\]$/.test(body)) return url;
  return `${scheme}[blocked-body n=${body.length},fp=${fingerprintForLog(body)}]`;
}

// Redact a KNOWN search term from a URL, wherever it sits — including the
// places `redactSensitiveUrlParams` cannot see. That helper is param-NAME
// based (userinfo, `q=`/`token=`/… query params, fragment params), so it is
// blind to a term embedded in the URL *path* or in a param under a name that
// is not in the sensitive/search lists. A safe-mode custom template can put
// the term exactly there: `https://example.com/search/%s` (validateUrl accepts
// any http(s) template with a %s) → createTargetUrl embeds
// encodeURIComponent(term) in the path → the plaintext term reaches the
// "Redirecting Tab" console line and the ring buffer's targetUrl, re-leaking
// the #12 contract ("no plaintext term in the ring buffer, not just outside
// the query field").
//
// The replace is boundary-bounded — the term is only stripped when it sits at
// a real URL boundary (segment start/end, or a ? # & = ; + separator) — so a
// short common term (e.g. "a") never corrupts the host or an unrelated
// segment: `…/search/a` → `…/search/[REDACTED]`, but `…/example.com/a/x`
// leaves the "a" in the host/segment alone. Both the encoded and the raw term
// are matched (createTargetUrl always percent-encodes, but a URL built some
// other way may not). The result is then passed through
// redactSensitiveUrlParams so named credential/query params are still
// stripped — i.e. this is a strict superset of param redaction, not a
// replacement. Idempotent (a second run finds no boundary term to strip), and
// an empty/non-string term degrades to plain param redaction, so existing
// call sites that don't know the term keep their current behaviour.
export function redactTermFromUrl(url, term) {
  if (typeof url !== 'string' || !url) return url;
  // A blocked-scheme URL has an OPAQUE body where a substituted term hides
  // (`javascript:alert(<term>)`) — there, fingerprinting the whole body
  // (redactBlockedUrl) is the correct #12 treatment, not term-stripping.
  // Delegating here keeps redactTermFromUrl a strict superset of
  // redactBlockedUrl, which is itself a superset of redactSensitiveUrlParams.
  if (isBlockedScheme(url.trim())) return redactBlockedUrl(url);
  if (typeof term !== 'string' || term === '') return redactSensitiveUrlParams(url);
  // encodeURIComponent can throw on lone surrogates (the #91 class) — the
  // raw-term needle still covers that case, so degrade to it.
  let encoded;
  try { encoded = encodeURIComponent(term); } catch { encoded = null; }
  const needles = [...new Set([encoded, term].filter((n) => typeof n === 'string' && n !== ''))];
  let out = url;
  for (const needle of needles) {
    if (!needle) continue;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = String.raw`(?<=^|[/\?#&=;+])`;
    const re = new RegExp(boundary + escaped + String.raw`(?=$|[/\?#&=;+])`, 'g');
    out = out.replace(re, '[REDACTED]');
  }
  return redactSensitiveUrlParams(out);
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
    // #95: this catch fires exactly when `new URL(url)` above threw — i.e.
    // the input is a URL the parser rejects but the engine regex still
    // matched (out-of-range port, malformed host, ...). It used to log the
    // raw url, the one spot in the redirect core outside the #12 redaction
    // contract. redactSensitiveUrlParams() is total: for the unparseable
    // input it falls back to best-effort raw-string redaction of the same
    // sensitive/query param names at ? / & / # boundaries, so the term in
    // `q=...` never reaches the console on this path either.
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
