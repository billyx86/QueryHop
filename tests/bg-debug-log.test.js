// Ring-buffer + redaction coverage for the background debug log (issue #114).
//
// bgDebugLog.js is a 200-entry, opt-in ring buffer in chrome.storage.session.
// Entries never carry a plaintext search term: the query field is replaced
// with a length + FNV-1a fingerprint and logged URLs are stripped of
// credential/search params (and blocked-scheme bodies are fingerprinted).
// These tests pin the persist contract — the 200-entry cap, the evicted-count
// disclosure, the opt-in gate, the session-storage home, the redaction at the
// persist boundary, and the clear/read surface — against a controllable chrome
// mock. The debug log only records while the "Record debug log" option is on,
// so each test primes bgSettings (the module that owns the flag) first.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const settings = await import('../QueryHop Extension/Resources/bgSettings.js');
const log = await import('../QueryHop Extension/Resources/bgDebugLog.js');

// A chrome mock with both storage.local (bgSettings) and storage.session
// (bgDebugLog) backed by plain objects, with call counters and an injectable
// error. get() resolves "defaults then stored", mirroring the real API.
function makeChromeMock(local = {}, session = {}) {
  const state = {
    local: { ...local },
    session: { ...session },
    localGets: 0,
    sessionGets: 0,
    sessionSets: 0,
    nextError: null, // applies to whichever get/set runs next
  };
  const chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, cb) {
          state.localGets += 1;
          chrome.runtime.lastError = null;
          const out = {};
          for (const [k, def] of Object.entries(keys)) out[k] = def;
          for (const [k, v] of Object.entries(state.local)) out[k] = v;
          if (state.nextError) {
            chrome.runtime.lastError = state.nextError;
            state.nextError = null;
          }
          cb(out);
        },
      },
      session: {
        get(keys, cb) {
          state.sessionGets += 1;
          chrome.runtime.lastError = null;
          const out = {};
          for (const [k, def] of Object.entries(keys)) out[k] = def;
          for (const [k, v] of Object.entries(state.session)) out[k] = v;
          if (state.nextError) {
            chrome.runtime.lastError = state.nextError;
            state.nextError = null;
          }
          cb(out);
        },
        set(data, cb) {
          state.sessionSets += 1;
          chrome.runtime.lastError = null;
          if (state.nextError) {
            chrome.runtime.lastError = state.nextError;
            state.nextError = null;
          }
          Object.assign(state.session, data);
          cb && cb();
        },
      },
    },
    _state: state,
  };
  return chrome;
}

// Turn the opt-in on: prime the settings mock with debugLogEnabled=true and
// run a getSettings() so the module flag that bgDebugLog reads goes true.
async function enableDebugLog(mock) {
  mock._state.local.debugLogEnabled = true;
  settings.invalidateSettingsCache();
  await settings.getSettings();
}

beforeEach(() => {
  globalThis.chrome = makeChromeMock();
  settings.invalidateSettingsCache();
});

// ---------------------------------------------------------------------------
// opt-in gate
// ---------------------------------------------------------------------------
test('appendDebugLog: no-op while the debug log is disabled', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  await log.appendDebugLog('redirect', { engine: 'kagi', query: 'hello world' });
  assert.equal(mock._state.sessionSets, 0, 'nothing is persisted when disabled');
  assert.equal(mock._state.session.queryhopDebugLog, undefined);
});

test('appendDebugLog: persists an entry once enabled', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  await enableDebugLog(mock);
  await log.appendDebugLog('redirect', { engine: 'kagi' });
  assert.equal(mock._state.sessionSets, 1);
  const entries = mock._state.session.queryhopDebugLog;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'redirect');
  assert.equal(entries[0].engine, 'kagi');
  assert.ok(entries[0].time, 'each entry carries an ISO timestamp');
});

// ---------------------------------------------------------------------------
// redaction at the persist boundary
// ---------------------------------------------------------------------------
test('appendDebugLog: the query is stored fingerprinted, never plaintext', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  await enableDebugLog(mock);
  const term = 'what is a quasar?';
  await log.appendDebugLog('redirect', { query: term, targetUrl: 'https://kagi.com/search?q=' + encodeURIComponent(term) });
  const [entry] = mock._state.session.queryhopDebugLog;
  assert.notEqual(entry.query, term, 'the plaintext term must not be persisted');
  assert.equal(entry.query, `n=${term.length},fp=${log.fingerprintForLog(term)}`);
  // The term must also be gone from the URL's q= param. URL serialization
  // percent-encodes the marker's brackets (q=%5BREDACTED%5D), so assert on
  // the marker text itself, which survives encoding verbatim.
  assert.ok(!entry.targetUrl.includes(term), 'the URL param is redacted');
  assert.ok(entry.targetUrl.includes('REDACTED'), 'the q= param carries the redaction marker');
});

test('appendDebugLog: credential-looking URL params are stripped', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  await enableDebugLog(mock);
  await log.appendDebugLog('redirect', {
    targetUrl: 'https://e.com/s?token=abc123&key=xyz&sid=99&safe=1',
  });
  const [entry] = mock._state.session.queryhopDebugLog;
  assert.ok(!entry.targetUrl.includes('abc123'), 'token value stripped');
  assert.ok(!entry.targetUrl.includes('xyz'), 'key value stripped');
  assert.ok(!entry.targetUrl.includes('sid=99'), 'sid value stripped');
  assert.ok(entry.targetUrl.includes('safe=1'), 'benign params are left alone');
});

test('appendDebugLog: a blocked-scheme target is fingerprinted, not stored raw', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  await enableDebugLog(mock);
  const payload = 'javascript:alert("the search term")';
  await log.appendDebugLog('blocked_scheme', { targetUrl: payload });
  const [entry] = mock._state.session.queryhopDebugLog;
  assert.ok(!entry.targetUrl.includes('the search term'), 'the body term is not stored');
  assert.ok(entry.targetUrl.startsWith('javascript:'), 'the scheme is kept as the security signal');
  assert.match(entry.targetUrl, /\[blocked-body n=\d+,fp=[0-9a-f]{8}\]/);
});

test('redactDebugEntry: URL fields are idempotent across a second pass', () => {
  // The #12 contract is byte-stability of the URL fields (redactBlockedUrl is
  // idempotent by design: its [blocked-body …] marker is detected and left
  // alone). The query field is a single-pass transform (redactQueryForLog
  // fingerprints whatever it is handed), so it is not part of the idempotency
  // contract — the ring buffer serializes entries only once, so that is fine.
  const entry = { query: 'secret term', targetUrl: 'javascript:alert(secret term)' };
  log.redactDebugEntry(entry);
  const once = entry.targetUrl;
  log.redactDebugEntry(entry);
  assert.equal(entry.targetUrl, once, 'a second redaction pass must not drift the URL field');
  assert.match(entry.targetUrl, /\[blocked-body n=\d+,fp=[0-9a-f]{8}\]/);
});

// ---------------------------------------------------------------------------
// ring-buffer cap + evicted-count disclosure
// ---------------------------------------------------------------------------
test('the ring buffer caps at 200 entries and counts evictions', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  await enableDebugLog(mock);
  // Append 210 entries; the buffer must hold the newest 200 and report 10
  // evicted.
  for (let i = 0; i < 210; i++) {
    await log.appendDebugLog('evt', { n: i });
  }
  const entries = mock._state.session.queryhopDebugLog;
  assert.equal(entries.length, log.DEBUG_LOG_MAX_ENTRIES);
  assert.equal(entries[0].n, 10, 'the oldest 10 were evicted (FIFO)');
  assert.equal(entries[entries.length - 1].n, 209, 'the newest entry is retained');
  assert.equal(mock._state.session.queryhopDebugLogDropped, 10);
});

test('readDebugLogDroppedCount: reports the evicted count, 0 when none', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  await enableDebugLog(mock);
  assert.equal(await log.readDebugLogDroppedCount(), 0);
  for (let i = 0; i < 205; i++) await log.appendDebugLog('evt', { n: i });
  assert.equal(await log.readDebugLogDroppedCount(), 5);
});

// ---------------------------------------------------------------------------
// session-storage home + clear/read surface
// ---------------------------------------------------------------------------
test('clearDebugLog: empties the buffer and resets the evicted count', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  await enableDebugLog(mock);
  await log.appendDebugLog('evt', { n: 1 });
  await log.clearDebugLog();
  const entries = await log.readDebugLog();
  assert.deepEqual(entries, []);
  assert.equal(await log.readDebugLogDroppedCount(), 0);
});

test('readDebugLog: returns an empty array when nothing is stored', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  const entries = await log.readDebugLog();
  assert.deepEqual(entries, []);
});

test('the log lives in session storage, not local storage', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  await enableDebugLog(mock);
  await log.appendDebugLog('evt', { n: 1 });
  assert.ok(mock._state.session.queryhopDebugLog, 'present in session storage');
  assert.equal(mock._state.local.queryhopDebugLog, undefined, 'absent from local storage');
});

test('appendDebugLog: a failing session set does not throw', async () => {
  const mock = makeChromeMock();
  globalThis.chrome = mock;
  await enableDebugLog(mock);
  mock._state.nextError = { message: 'session storage unavailable' };
  await assert.doesNotReject(() => log.appendDebugLog('evt', { n: 1 }));
});
