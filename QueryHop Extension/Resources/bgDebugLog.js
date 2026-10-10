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

import { logMessage, fingerprintForLog, redactQueryForLog, redactSensitiveUrlParams, redactBlockedUrl } from './bgCommon.js';
import { isDebugLogEnabled } from './bgSettings.js';

// The #12 redaction helpers (fingerprintForLog / redactQueryForLog /
// redactSensitiveUrlParams / redactBlockedUrl) now live in bgCommon.js (#91)
// so the console paths can use them too; re-exported here to keep this
// module's import surface (and background.js's re-exports) unchanged.
export { fingerprintForLog, redactQueryForLog, redactSensitiveUrlParams, redactBlockedUrl };

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

// Apply the #12 redaction rules to a debug log entry, in place, and return it.
// URL fields go through redactBlockedUrl, not redactSensitiveUrlParams, so a
// blocked-scheme target (whose `%s`-substituted body carries the plaintext
// term in an opaque scheme-specific part that param-redaction can't reach) is
// fingerprinted at the persist boundary — covering both the ring buffer and
// the console mirror in appendDebugLog. For non-blocked URLs it degrades to
// redactSensitiveUrlParams, so redirect entries behave exactly as before.
export function redactDebugEntry(entry) {
  if (entry && typeof entry.query === 'string') {
    entry.query = redactQueryForLog(entry.query);
  }
  for (const field of ['originalUrl', 'targetUrl']) {
    if (entry && typeof entry[field] === 'string') {
      entry[field] = redactBlockedUrl(entry[field]);
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
