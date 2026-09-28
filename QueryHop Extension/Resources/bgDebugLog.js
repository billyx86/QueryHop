//
//  bgDebugLog.js
//  QueryHop Extension
//
// Debug log (#8), with query redaction (#12) — split out of background.js
// in #50. A lightweight, opt-in ring buffer that records what the extension
// did with each search: which engine matched, whether unsafe mode was
// active, and any blocked-scheme attempts the denylist rejected. It exists
// because the extension otherwise rewrites search URLs silently, with no
// way to tell what matched or why a redirect (or refusal) happened.
//
// Privacy: entries live in chrome.storage.session (cleared when the browser
// exits), are never sent anywhere, and are only recorded at all while the
// user has the "Record debug log" option enabled. Blocked-scheme refusals
// are additionally mirrored to the console unconditionally — those are the
// code-injection attempts worth seeing even without the opt-in log.
//
// Since #12, the ring buffer never stores a plaintext search term: the
// `query` field is replaced with a length + FNV-1a fingerprint, and every
// logged URL is stripped of credential-looking query parameters (token=,
// key=, code=, sid=, ...) before it is persisted. The fingerprint is
// deterministic, so the user can still correlate entries and confirm a
// redirect fired for the same search.

import { logMessage } from './bgCommon.js';
import { isDebugLogEnabled } from './bgSettings.js';

const DEBUG_LOG_KEY = 'queryhopDebugLog';
// #19: how many entries have been evicted from the ring buffer this session.
// Persisted next to the log so the copy/export can disclose truncation.
const DEBUG_LOG_DROPPED_KEY = 'queryhopDebugLogDropped';
export const DEBUG_LOG_MAX_ENTRIES = 200;
const DEBUG_LOG_URL_LIMIT = 200;

export function truncateForLog(value, limit = DEBUG_LOG_URL_LIMIT) {
  const s = typeof value === 'string' ? value : String(value == null ? '' : value);
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

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
// plaintext in the logged URLs would re-leak the search term (#12).
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

// Redact query parameters in a URL for logging (#12). Two classes, both
// replaced with [REDACTED] (the parameter name stays, so entries are still
// readable):
//   1. credential-looking names (token=, key=, code=, sid=, ...) — never
//      persist a potential secret, and
//   2. search-query names (q=, wd=, text=, ...) — the entry's `query` field
//      is already fingerprinted, so leaving the term inside a URL would
//      re-leak it (acceptance criterion: no plaintext search term in the
//      ring buffer, not just outside the `query` field).
// Returns the input unchanged if it isn't a parseable URL or nothing matched.
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
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

// Apply the #12 redaction rules to a debug log entry, in place, and return it.
export function redactDebugEntry(entry) {
  if (entry && typeof entry.query === 'string') {
    entry.query = redactQueryForLog(entry.query);
  }
  for (const field of ['originalUrl', 'targetUrl']) {
    if (entry && typeof entry[field] === 'string') {
      entry[field] = redactSensitiveUrlParams(entry[field]);
    }
  }
  return entry;
}

export async function appendDebugLog(event, details) {
  if (!isDebugLogEnabled()) return;
  const entry = redactDebugEntry({
    time: new Date().toISOString(),
    event,
    ...(details || {})
  });
  // Console mirror (within the opt-in) so the log is visible in the service
  // worker devtools even if the storage write fails. Entry is already
  // redacted (#12) — no plaintext search term reaches the console either.
  console.log('[QueryHop debug]', entry);
  try {
    const items = await chromeStorageSessionGet({
      [DEBUG_LOG_KEY]: [],
      [DEBUG_LOG_DROPPED_KEY]: 0
    });
    const log = Array.isArray(items[DEBUG_LOG_KEY]) ? items[DEBUG_LOG_KEY] : [];
    let dropped = Number(items[DEBUG_LOG_DROPPED_KEY]) || 0;
    log.push(entry);
    while (log.length > DEBUG_LOG_MAX_ENTRIES) {
      log.shift();
      dropped += 1;
    }
    await chromeStorageSessionSet({ [DEBUG_LOG_KEY]: log, [DEBUG_LOG_DROPPED_KEY]: dropped });
  } catch (error) {
    logMessage('warn', `debug log: failed to persist entry (${error.message})`);
  }
}

export async function clearDebugLog() {
  try {
    await chromeStorageSessionSet({ [DEBUG_LOG_KEY]: [], [DEBUG_LOG_DROPPED_KEY]: 0 });
  } catch (error) {
    logMessage('warn', `debug log: failed to clear (${error.message})`);
  }
}

export async function readDebugLog() {
  try {
    const items = await chromeStorageSessionGet({
      [DEBUG_LOG_KEY]: [],
      [DEBUG_LOG_DROPPED_KEY]: 0
    });
    return Array.isArray(items[DEBUG_LOG_KEY]) ? items[DEBUG_LOG_KEY] : [];
  } catch (error) {
    logMessage('warn', `debug log: failed to read (${error.message})`);
    return [];
  }
}

// #19: how many entries were evicted from the ring buffer this session.
// 0 when nothing has overflowed. Lets the copy/export disclose truncation
// instead of silently handing over the most recent 200 as "the whole log".
export async function readDebugLogDroppedCount() {
  try {
    const items = await chromeStorageSessionGet({ [DEBUG_LOG_DROPPED_KEY]: 0 });
    return Number(items[DEBUG_LOG_DROPPED_KEY]) || 0;
  } catch (error) {
    logMessage('warn', `debug log: failed to read drop count (${error.message})`);
    return 0;
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
