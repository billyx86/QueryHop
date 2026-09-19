//
//  popupRules.js
//  QueryHop Extension
//
// Pure rules/validation/formatting logic used by the popup (popup.js).
//
// Kept free of any DOM or chrome.* access so it can be imported directly by
// the unit tests in tests/popup-rules.test.js (node --test) — the same
// pattern background.js follows. The popup imports these and layers the DOM
// wiring, validation caching and chrome.storage calls on top.
//
// NOTE: BLOCKED_SCHEMES below is kept in sync with background.js. If one
// changes, change both — the popup refuses to *configure* a scheme the
// background worker would also refuse to *apply*.
//

// Kept in sync with background.js: schemes that are rejected even in
// unsafe mode (see background.js BLOCKED_SCHEMES).
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

// True when the (trimmed, lowercased) URL starts with a denylisted scheme.
// Only a *leading* scheme counts — `?x=javascript:alert(1)` is not blocked.
export function isBlockedScheme(url) {
  const lower = (typeof url === 'string' ? url : '').trim().toLowerCase();
  return BLOCKED_SCHEMES.some(scheme => lower.startsWith(scheme));
}

// ---------------------------------------------------------------------------
// Custom-URL validation (pure; the popup wraps this with a cache)
//
// Returns { isValid, message, type } exactly as the popup renders:
//   type 'valid'       — green: URL is acceptable
//   type 'info-empty'  — leaving the URL blank disables redirection
//   type 'info-bypass' — unsafe mode: validation skipped
//   type 'invalid'     — red: reject the save
// ---------------------------------------------------------------------------
export function validateSearchUrl(url, isUnsafeMode) {
  const raw = typeof url === 'string' ? url : '';
  const trimmedUrl = raw.trim();

  if (!trimmedUrl) {
    return {
      isValid: true,
      message: 'Leaving the URL empty will disable redirection',
      type: 'info-empty'
    };
  }

  if (!isUnsafeMode) {
    if (!trimmedUrl.includes('%s')) {
      return {
        isValid: false,
        message: "URL must include %s in place of your query",
        type: 'invalid'
      };
    }
    if (!trimmedUrl.toLowerCase().startsWith('http://') &&
        !trimmedUrl.toLowerCase().startsWith('https://')) {
      return {
        isValid: false,
        message: "URL must start with http(s)://",
        type: 'invalid'
      };
    }
    try {
      // Substitute a probe string for every %s and check the URL parses.
      new URL(trimmedUrl.replace(/%s/g, 'testQuery'));
      return {
        isValid: true,
        message: "URL format valid",
        type: 'valid'
      };
    } catch (e) {
      return {
        isValid: false,
        message: "Invalid URL format",
        type: 'invalid'
      };
    }
  }

  // Unsafe mode relaxes the http/https + %s requirements, but never
  // the scheme denylist (see background.js).
  if (isBlockedScheme(trimmedUrl)) {
    return {
      isValid: false,
      message: "URL scheme is not allowed, even in unsafe mode",
      type: 'invalid'
    };
  }
  return {
    isValid: true,
    message: 'URL validation is disabled',
    type: 'info-bypass'
  };
}

// ---------------------------------------------------------------------------
// Debug log formatting (#8, redaction per #12/#13)
//
// One line per entry, matching what the popup renders in the "Recent
// activity" pane. Entries arrive pre-redacted from the background worker,
// so formatting here can never reintroduce a plaintext search term.
// ---------------------------------------------------------------------------

// The view pane is deliberately short; the full log stays available in the
// background worker's ring buffer.
export const DEBUG_LOG_VIEW_LIMIT = 50;

export const DEBUG_LOG_EMPTY_TEXT = 'Debug log is empty.';

function formatLogTime(time) {
  return (time || '').replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// Format a single debug log entry as one line.
export function formatDebugLogEntry(entry) {
  const time = formatLogTime(entry.time);
  if (entry.event === 'blocked_scheme') {
    return `[${time}] BLOCKED  ${entry.targetUrl || '(no target)'}  (from ${entry.originalUrl || 'unknown'})`;
  }
  if (entry.event === 'redirect') {
    const unsafe = entry.unsafeMode ? '  [validation disabled]' : '';
    return `[${time}] ${entry.engine || 'engine'}: ${entry.query || 'q=(none)'} → ${entry.targetUrl || ''}${unsafe}`;
  }
  return `[${time}] ${entry.event} ${JSON.stringify(entry)}`;
}

// The lines the popup renders: newest first, capped at DEBUG_LOG_VIEW_LIMIT.
// Non-array / empty input yields [].
export function formatDebugLogViewLines(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  return entries.slice(-DEBUG_LOG_VIEW_LIMIT).reverse().map(formatDebugLogEntry);
}

// What the "Recent activity" pane shows: the joined lines, or the empty
// placeholder text.
export function formatDebugLogViewText(entries) {
  const lines = formatDebugLogViewLines(entries);
  return lines.length ? lines.join('\n') : DEBUG_LOG_EMPTY_TEXT;
}

// ---------------------------------------------------------------------------
// Debug log export (#15)
//
// Plain text for the Copy-log button. Unlike the view it is NOT capped at
// DEBUG_LOG_VIEW_LIMIT — the point of the export is to hand over the whole
// session log. The note documents the #12 redaction guarantee so anyone
// receiving the copy knows what (isn't) in it.
// ---------------------------------------------------------------------------
export const DEBUG_LOG_COPY_NOTE =
  'Note: search terms are redacted (kept only as a length + non-reversible fingerprint) and credential-looking URL parameters are shown as [REDACTED]. Nothing above was sent anywhere; the log lives only in this browser session.';

// Deterministic (no timestamps) so it is trivially unit-testable.
// Returns '' when there is nothing to copy.
export function formatDebugLogForCopy(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const count = entries.length;
  const lines = entries.map(formatDebugLogEntry);
  return [
    `QueryHop debug log — ${count} ${count === 1 ? 'entry' : 'entries'}`,
    '',
    ...lines,
    '',
    DEBUG_LOG_COPY_NOTE
  ].join('\n');
}
