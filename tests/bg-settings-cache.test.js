// TTL-cache coverage for the background settings accessor (issue #113).
//
// bgSettings.js is a 15 s TTL-cached wrapper over chrome.storage.local. The
// navigation handler reads the settings on every top-frame navigation, so the
// cache keeps the hot path to at most one storage read per burst. It also
// feeds the debug log: getSettings() syncs the module-level debugLogEnabled
// flag that bgDebugLog.js checks before persisting. These tests pin the cache
// contract — hit within the TTL, miss after it, invalidation, default merge,
// error handling, and the flag sync — using a controllable chrome mock and a
// frozen Date.now so the 15 s boundary is deterministic.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeSettingsMock(stored = {}, opts = {}) {
  const state = {
    storage: { ...stored },
    calls: 0,
    nextError: null,
    // If set, storage.local.get returns this value verbatim (default-merge
    // skipped) — lets us exercise the "unexpected non-object return" path.
    forceReturn: undefined,
    ...opts,
  };
  const chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, cb) {
          state.calls += 1;
          chrome.runtime.lastError = null;
          if (state.forceReturn !== undefined) {
            cb(state.forceReturn);
            return;
          }
          const out = {};
          for (const [k, def] of Object.entries(keys)) out[k] = def;
          for (const [k, v] of Object.entries(state.storage)) out[k] = v;
          if (state.nextError) {
            chrome.runtime.lastError = state.nextError;
            state.nextError = null;
          }
          cb(out);
        },
      },
    },
    _state: state,
  };
  return chrome;
}

// Fresh mock + cleared cache, so every test starts from a known state. The
// module is ESM and reads `chrome` at call time, so reassigning globalThis
// between tests is the control surface (same pattern as background.test.js).
const bg = await import('../QueryHop Extension/Resources/bgSettings.js');

beforeEach(() => {
  globalThis.chrome = makeSettingsMock();
  bg.invalidateSettingsCache();
});

function setup(stored = {}, opts = {}) {
  const mock = makeSettingsMock(stored, opts);
  globalThis.chrome = mock;
  bg.invalidateSettingsCache();
  return mock;
}

// ---------------------------------------------------------------------------
// SETTINGS_KEYS / defaults
// ---------------------------------------------------------------------------
test('SETTINGS_KEYS names exactly the four cached settings', () => {
  assert.deepEqual(
    [...bg.SETTINGS_KEYS].sort(),
    ['allowUnsafeMode', 'customSearchUrl', 'debugLogEnabled', 'extensionEnabled']
  );
});

test('getSettings: merges stored values over the defaults', async () => {
  setup({ extensionEnabled: true, customSearchUrl: 'https://duckduckgo.com/?q=%s' });
  const s = await bg.getSettings();
  assert.equal(s.extensionEnabled, true);
  assert.equal(s.customSearchUrl, 'https://duckduckgo.com/?q=%s');
  // Keys the user never set fall back to the defaults.
  assert.equal(s.allowUnsafeMode, false);
  assert.equal(s.debugLogEnabled, false);
});

// ---------------------------------------------------------------------------
// TTL caching
// ---------------------------------------------------------------------------
test('getSettings: a second read within the TTL hits the cache (one storage read)', async () => {
  const mock = setup({ extensionEnabled: true });
  const a = await bg.getSettings();
  const b = await bg.getSettings();
  assert.equal(mock._state.calls, 1, 'the second read must be served from the cache');
  assert.equal(a, b, 'both reads return the same cached object');
});

test('getSettings: the cache is re-read exactly once the 15 s TTL lapses', async () => {
  const mock = setup({ extensionEnabled: true });
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await bg.getSettings(); // cached at now = 1_000_000
    now += 14_999; // 14 999 ms < 15 000 -> still fresh
    await bg.getSettings();
    assert.equal(mock._state.calls, 1, 'just under the TTL must still be a cache hit');
    now += 1; // now - cacheTime === 15 000 -> no longer < TTL
    await bg.getSettings();
    assert.equal(mock._state.calls, 2, 'at exactly the TTL boundary a fresh read happens');
  } finally {
    Date.now = realNow;
  }
});

test('invalidateSettingsCache: forces a fresh read even inside the TTL', async () => {
  const mock = setup({ extensionEnabled: true });
  await bg.getSettings();
  bg.invalidateSettingsCache();
  await bg.getSettings();
  assert.equal(mock._state.calls, 2);
});

// ---------------------------------------------------------------------------
// debugLogEnabled flag sync
// ---------------------------------------------------------------------------
test('getSettings: syncs debugLogEnabled=true into isDebugLogEnabled()', async () => {
  setup({ debugLogEnabled: true });
  await bg.getSettings();
  assert.equal(bg.isDebugLogEnabled(), true);
});

test('getSettings: a default (unset) debugLogEnabled leaves the flag off', async () => {
  setup({});
  await bg.getSettings();
  assert.equal(bg.isDebugLogEnabled(), false);
});

test('getSettings: the flag re-syncs when a fresh read sees a changed value', async () => {
  const mock = setup({ debugLogEnabled: true });
  await bg.getSettings();
  assert.equal(bg.isDebugLogEnabled(), true);
  // The user toggles the option off; the popup's save path invalidates the
  // cache, so the next read picks up the new value.
  mock._state.storage.debugLogEnabled = false;
  bg.invalidateSettingsCache();
  await bg.getSettings();
  assert.equal(bg.isDebugLogEnabled(), false);
});

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------
test('getSettings: returns null when storage surfaces an error', async () => {
  const mock = setup({ extensionEnabled: true });
  mock._state.nextError = { message: 'storage broken' };
  const s = await bg.getSettings();
  assert.equal(s, null);
});

test('getSettings: an error is not cached — the next read retries storage', async () => {
  const mock = setup({ extensionEnabled: true });
  mock._state.nextError = { message: 'storage broken' };
  assert.equal(await bg.getSettings(), null);
  // Error consumed; storage is healthy again. Because the failed read did not
  // prime the cache, this must hit storage a second time and succeed.
  const s = await bg.getSettings();
  assert.equal(mock._state.calls, 2);
  assert.equal(s.extensionEnabled, true);
});

test('getSettings: a non-object storage return is treated as a failure', async () => {
  const mock = setup();
  mock._state.forceReturn = 'garbage';
  const s = await bg.getSettings();
  assert.equal(s, null);
});
