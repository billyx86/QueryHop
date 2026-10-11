// Unit tests for the pure redirect/validation logic in
// QueryHop Extension/Resources/background.js.
//
// Run with `node --test` (see package.json). The extension background script
// references the `chrome` global, which does not exist under Node — so we
// install a controllable mock on globalThis BEFORE importing the module. The
// exported functions resolve `chrome` from the global at call time, so we can
// swap the mock per test.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { logMessage } from '../QueryHop Extension/Resources/bgCommon.js';

function makeChromeMock(stored = {}, sessionStored = {}) {
  const state = {
    storage: { ...stored },
    session: { ...sessionStored },
    storageGetCalls: 0,
    storageChangeListeners: [],
    tabsUpdateCalls: [],
    onMessageListeners: [],
    nextStorageError: null,
  };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          state.onMessageListeners.push(listener);
        },
      },
    },
    webNavigation: {
      onBeforeNavigate: { addListener() {} },
    },
    storage: {
      onChanged: {
        addListener(listener) {
          state.storageChangeListeners.push(listener);
        },
      },
      local: {
        get(keys, cb) {
          state.storageGetCalls += 1;
          const out = {};
          for (const [k, def] of Object.entries(keys)) out[k] = def;
          for (const [k, v] of Object.entries(state.storage)) out[k] = v;
          if (state.nextStorageError) {
            chrome.runtime.lastError = state.nextStorageError;
            state.nextStorageError = null;
          }
          cb(out);
        },
      },
      // The debug log (#8) lives in session storage, so the mock provides it
      // too — with the same "defaults then stored" merge semantics as local.
      session: {
        get(keys, cb) {
          const out = {};
          for (const [k, def] of Object.entries(keys)) out[k] = def;
          for (const [k, v] of Object.entries(state.session)) out[k] = v;
          cb(out);
        },
        set(data, cb) {
          Object.assign(state.session, data);
          cb && cb();
        },
      },
    },
    tabs: {
      update(tabId, props) {
        state.tabsUpdateCalls.push({ tabId, ...props });
        return Promise.resolve();
      },
    },
    _state: state,
  };
  return chrome;
}

// Import-time chrome usage is limited to event-listener registration, so a bare
// mock is enough here. Per-test tests reassign globalThis.chrome as needed.
const importMock = makeChromeMock();
globalThis.chrome = importMock;

const bg = await import('../QueryHop Extension/Resources/background.js');

beforeEach(() => {
  globalThis.chrome = makeChromeMock();
  bg.invalidateSettingsCache();
});

// ---------------------------------------------------------------------------
// isBlockedScheme
// ---------------------------------------------------------------------------
test('isBlockedScheme: rejects every denylisted scheme', () => {
  for (const scheme of [
    'javascript:alert(1)',
    'vbscript:MsgBox(1)',
    'data:text/html,<script>',
    'file:///etc/passwd',
    'chrome-extension://abc/index.html',
    'safari-web-extension://abc/index.html',
    'about:blank',
    'view-source:https://example.com',
  ]) {
    assert.equal(bg.isBlockedScheme(scheme), true, `should block ${scheme}`);
  }
});

test('isBlockedScheme: is case- and whitespace-insensitive', () => {
  assert.equal(bg.isBlockedScheme('JAVASCRIPT:alert(1)'), true);
  assert.equal(bg.isBlockedScheme('  JavaScript:alert(1)'), true);
  assert.equal(bg.isBlockedScheme('DATA:text/html,x'), true);
});

test('isBlockedScheme: allows ordinary http/https and unknown schemes', () => {
  assert.equal(bg.isBlockedScheme('https://example.com'), false);
  assert.equal(bg.isBlockedScheme('http://example.com'), false);
  assert.equal(bg.isBlockedScheme('ftp://example.com'), false);
});

test('isBlockedScheme: only matches a leading scheme, not a substring', () => {
  assert.equal(bg.isBlockedScheme('myjavascript:foo'), false);
  assert.equal(bg.isBlockedScheme('https://example.com/?x=javascript:alert(1)'), false);
});

test('isBlockedScheme: null / empty / undefined are not blocked', () => {
  assert.equal(bg.isBlockedScheme(null), false);
  assert.equal(bg.isBlockedScheme(''), false);
  assert.equal(bg.isBlockedScheme(undefined), false);
});

// ---------------------------------------------------------------------------
// validateUrl — safe mode
// ---------------------------------------------------------------------------
test('validateUrl (safe): empty URL is valid info (disables redirect)', () => {
  const r = bg.validateUrl('', false);
  assert.equal(r.isValid, true);
  assert.equal(r.type, 'info');
});

test('validateUrl (safe): missing %s placeholder is invalid', () => {
  const r = bg.validateUrl('https://duckduckgo.com/?q=hi', false);
  assert.equal(r.isValid, false);
  assert.equal(r.type, 'invalid');
});

test('validateUrl (safe): non-http scheme is invalid', () => {
  const r = bg.validateUrl('ftp://example.com/?q=%s', false);
  assert.equal(r.isValid, false);
});

test('validateUrl (safe): valid http + https targets pass', () => {
  assert.equal(bg.validateUrl('http://duckduckgo.com/?q=%s', false).isValid, true);
  assert.equal(bg.validateUrl('https://www.ecosia.org/search?q=%s', false).isValid, true);
});

test('validateUrl (safe): http prefix check is case-insensitive', () => {
  const r = bg.validateUrl('HTTPS://example.com/search?q=%s', false);
  assert.equal(r.isValid, true);
});

test('validateUrl (safe): malformed URL (after %s substitution) is invalid', () => {
  // "http://exa mple.com/%s" has a space in the host -> invalid URL.
  const r = bg.validateUrl('http://exa mple.com/search?q=%s', false);
  assert.equal(r.isValid, false);
  assert.equal(r.type, 'invalid');
});

// ---------------------------------------------------------------------------
// validateUrl — unsafe mode
// ---------------------------------------------------------------------------
test('validateUrl (unsafe): blocked schemes are still rejected', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x']) {
    const r = bg.validateUrl(url, true);
    assert.equal(r.isValid, false, `should reject ${url}`);
  }
});

test('validateUrl (unsafe): http target without %s is allowed (bypassed)', () => {
  const r = bg.validateUrl('https://example.com/search', true);
  assert.equal(r.isValid, true);
  assert.equal(r.type, 'info');
});

test('validateUrl (unsafe): non-http, non-blocked scheme is allowed', () => {
  const r = bg.validateUrl('ftp://example.com/x', true);
  assert.equal(r.isValid, true);
});

// ---------------------------------------------------------------------------
// createTargetUrl
// ---------------------------------------------------------------------------
test('createTargetUrl: empty custom URL returns null', () => {
  assert.equal(bg.createTargetUrl('', 'query', false), null);
  assert.equal(bg.createTargetUrl('   ', 'query', false), null);
});

test('createTargetUrl: replaces a single %s with the encoded query', () => {
  const url = bg.createTargetUrl('https://duckduckgo.com/?q=%s', 'hello', false);
  assert.equal(url, 'https://duckduckgo.com/?q=hello');
});

test('createTargetUrl: URL-encodes the query', () => {
  const url = bg.createTargetUrl('https://duckduckgo.com/?q=%s', 'hello world & co', false);
  assert.equal(url, 'https://duckduckgo.com/?q=hello%20world%20%26%20co');
});

test('createTargetUrl: replaces every %s occurrence', () => {
  const url = bg.createTargetUrl('https://e.com/%s/%s', 'x', false);
  assert.equal(url, 'https://e.com/x/x');
});

test('createTargetUrl: without %s + unsafe returns the trimmed URL', () => {
  const url = bg.createTargetUrl('  https://e.com/custom  ', 'query', true);
  assert.equal(url, 'https://e.com/custom');
});

test('createTargetUrl: without %s + safe returns null (misconfiguration)', () => {
  assert.equal(bg.createTargetUrl('https://e.com/custom', 'query', false), null);
});

// ---------------------------------------------------------------------------
// extractSearchQuery
// ---------------------------------------------------------------------------
test('extractSearchQuery: reads the primary query param per engine', () => {
  const { searchEngines } = bg;
  const byPattern = (sub) => searchEngines.find((e) => e.pattern.source.includes(sub));

  assert.equal(
    bg.extractSearchQuery('https://www.google.com/search?q=hello%20world', byPattern('google')),
    'hello world'
  );
  assert.equal(
    bg.extractSearchQuery('https://duckduckgo.com/?q=ddg', byPattern('duckduckgo')),
    'ddg'
  );
  assert.equal(
    bg.extractSearchQuery('https://www.bing.com/search?q=bingq', byPattern('bing')),
    'bingq'
  );
  assert.equal(
    bg.extractSearchQuery('https://www.ecosia.org/search?q=eco', byPattern('ecosia')),
    'eco'
  );
  assert.equal(
    bg.extractSearchQuery('https://search.yahoo.com/search?p=yhq', byPattern('yahoo')),
    'yhq'
  );
  assert.equal(
    bg.extractSearchQuery('https://yandex.com/search/?text=yd', byPattern('yandex')),
    'yd'
  );
});

test('extractSearchQuery: baidu accepts either wd or word', () => {
  const baidu = bg.searchEngines.find((e) => e.pattern.source.includes('baidu'));
  assert.equal(bg.extractSearchQuery('https://www.baidu.com/s?wd=bw1', baidu), 'bw1');
  assert.equal(bg.extractSearchQuery('https://www.baidu.com/s?word=bw2', baidu), 'bw2');
});

test('extractSearchQuery: falls back to the URL fragment for the query', () => {
  const google = bg.searchEngines.find((e) => e.pattern.source.includes('google'));
  // No ?q= present, but #q=... in the fragment.
  assert.equal(bg.extractSearchQuery('https://www.google.com/search#q=frag', google), 'frag');
});

test('extractSearchQuery: returns null when the param is absent', () => {
  const google = bg.searchEngines.find((e) => e.pattern.source.includes('google'));
  assert.equal(bg.extractSearchQuery('https://www.google.com/search?foo=bar', google), null);
});

test('extractSearchQuery: returns null for an unparseable URL', () => {
  const google = bg.searchEngines.find((e) => e.pattern.source.includes('google'));
  assert.equal(bg.extractSearchQuery('not a url', google), null);
});

// ---------------------------------------------------------------------------
// searchEngines — drift guard (regexes must stay inside host_permissions)
// ---------------------------------------------------------------------------
test('searchEngines: defines exactly seven engines with pattern + queryParam', () => {
  assert.equal(bg.searchEngines.length, 7);
  for (const e of bg.searchEngines) {
    assert.ok(e.pattern instanceof RegExp, 'each engine has a RegExp pattern');
    assert.ok(e.queryParam, 'each engine declares a queryParam');
  }
});

test('searchEngines: google/yandex no longer match TLDs missing from host_permissions', () => {
  // These are the exact drift the fix removes — they must NOT match now.
  const outOfPermission = [
    'https://www.google.ru/search?q=x',
    'https://www.google.org/search?q=x',
    'https://www.google.cn/search?q=x',
    'https://yandex.de/search/?text=x',
    'https://yandex.in/search/?text=x',
  ];
  for (const url of outOfPermission) {
    const matched = bg.searchEngines.some((e) => e.pattern.test(url));
    assert.equal(matched, false, `should no longer match ${url}`);
  }
});

test('searchEngines: still matches every in-permission TLD sample', () => {
  const inPermission = [
    'https://www.google.com/search?q=x',
    'https://google.co.uk/search?q=x',
    'https://www.google.de/search?q=x',
    'https://www.google.com.au/search?q=x',
    'https://www.google.com.br/search?q=x',
    'https://www.google.co.in/search?q=x',
    'https://www.google.co.jp/search?q=x',
    'https://www.google.es/search?q=x',
    'https://www.google.it/search?q=x',
    'https://www.google.nl/search?q=x',
    'https://duckduckgo.com/?q=x',
    'https://www.bing.com/search?q=x',
    'https://www.ecosia.org/search?q=x',
    'https://www.baidu.com/s?wd=x',
    'https://search.yahoo.com/search?p=x',
    'https://yandex.ru/search/?text=x',
    'https://yandex.kz/search/?text=x',
    'https://yandex.by/search/?text=x',
    'https://yandex.com/search/?text=x',
    'https://yandex.com.tr/search/?text=x',
  ];
  for (const url of inPermission) {
    const matched = bg.searchEngines.some((e) => e.pattern.test(url));
    assert.equal(matched, true, `should still match ${url}`);
  }
});

// ---------------------------------------------------------------------------
// redirectTab
// ---------------------------------------------------------------------------
test('redirectTab: normal redirect calls tabs.update and returns true', async () => {
  const ok = await bg.redirectTab(
    42,
    'https://duckduckgo.com/?q=hello',
    'https://www.google.com/search?q=hello'
  );
  assert.equal(ok, true);
  assert.deepEqual(globalThis.chrome._state.tabsUpdateCalls, [
    { tabId: 42, url: 'https://duckduckgo.com/?q=hello' },
  ]);
});

test('redirectTab: identical target is aborted without navigating', async () => {
  const same = 'https://duckduckgo.com/?q=hello';
  const ok = await bg.redirectTab(7, same, same);
  assert.equal(ok, false);
  assert.equal(globalThis.chrome._state.tabsUpdateCalls.length, 0);
});

test('redirectTab: blocked-scheme target is refused even by the sink guard', async () => {
  const ok = await bg.redirectTab(7, 'javascript:alert(1)', 'https://www.google.com/search?q=x');
  assert.equal(ok, false);
  assert.equal(globalThis.chrome._state.tabsUpdateCalls.length, 0);
});

test('redirectTab: a throwing tabs.update is caught and returns false', async () => {
  globalThis.chrome.tabs.update = () => Promise.reject(new Error('boom'));
  const ok = await bg.redirectTab(7, 'https://duckduckgo.com/?q=x', 'https://www.google.com/search?q=x');
  assert.equal(ok, false);
});

// ---------------------------------------------------------------------------
// handleNavigation (end-to-end over the mocked chrome API)
// ---------------------------------------------------------------------------
test('handleNavigation: no-op when the extension is disabled', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: false,
    customSearchUrl: 'https://duckduckgo.com/?q=%s',
  });
  bg.invalidateSettingsCache();
  await bg.handleNavigation({
    tabId: 1,
    frameId: 0,
    url: 'https://www.google.com/search?q=hi',
  });
  assert.equal(globalThis.chrome._state.tabsUpdateCalls.length, 0);
});

test('handleNavigation: no-op when no custom URL is configured', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: '',
  });
  bg.invalidateSettingsCache();
  await bg.handleNavigation({
    tabId: 1,
    frameId: 0,
    url: 'https://www.google.com/search?q=hi',
  });
  assert.equal(globalThis.chrome._state.tabsUpdateCalls.length, 0);
});

test('handleNavigation: enabled + custom URL redirects a Google search', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://duckduckgo.com/?q=%s',
  });
  bg.invalidateSettingsCache();
  await bg.handleNavigation({
    tabId: 5,
    frameId: 0,
    url: 'https://www.google.com/search?q=hello%20world',
  });
  assert.deepEqual(globalThis.chrome._state.tabsUpdateCalls, [
    { tabId: 5, url: 'https://duckduckgo.com/?q=hello%20world' },
  ]);
});

test('handleNavigation: no-op when the URL matches no engine', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://duckduckgo.com/?q=%s',
  });
  bg.invalidateSettingsCache();
  await bg.handleNavigation({
    tabId: 9,
    frameId: 0,
    url: 'https://example.com/not-a-search?q=hi',
  });
  assert.equal(globalThis.chrome._state.tabsUpdateCalls.length, 0);
});

test('handleNavigation: no-op when the query is empty', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://duckduckgo.com/?q=%s',
  });
  bg.invalidateSettingsCache();
  await bg.handleNavigation({
    tabId: 11,
    frameId: 0,
    url: 'https://www.google.com/search?q=',
  });
  assert.equal(globalThis.chrome._state.tabsUpdateCalls.length, 0);
});

// ---------------------------------------------------------------------------
// getSettings — storage + caching
// ---------------------------------------------------------------------------
test('getSettings: returns merged defaults from chrome.storage.local', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://duckduckgo.com/?q=%s',
  });
  bg.invalidateSettingsCache();
  const s = await bg.getSettings();
  assert.equal(s.extensionEnabled, true);
  assert.equal(s.customSearchUrl, 'https://duckduckgo.com/?q=%s');
  // Defaults for keys the user never set.
  assert.equal(s.allowUnsafeMode, false);
});

test('getSettings: caches within the TTL (single storage read)', async () => {
  globalThis.chrome = makeChromeMock({ extensionEnabled: true });
  bg.invalidateSettingsCache();
  await bg.getSettings();
  await bg.getSettings();
  assert.equal(globalThis.chrome._state.storageGetCalls, 1);
});

test('getSettings: invalidates only for local settings changes', async () => {
  const mock = makeChromeMock({ extensionEnabled: true });
  globalThis.chrome = mock;
  await bg.getSettings();
  assert.equal(mock._state.storageGetCalls, 1);

  for (const listener of importMock._state.storageChangeListeners) {
    listener({ debugLog: { newValue: [] } }, 'local');
    listener({ extensionEnabled: { newValue: false } }, 'sync');
  }
  await bg.getSettings();
  assert.equal(mock._state.storageGetCalls, 1);

  mock._state.storage.extensionEnabled = false;
  for (const listener of importMock._state.storageChangeListeners) {
    listener({ extensionEnabled: { oldValue: true, newValue: false } }, 'local');
  }
  const settings = await bg.getSettings();
  assert.equal(settings.extensionEnabled, false);
  assert.equal(mock._state.storageGetCalls, 2);
});

test('getSettings: invalidateSettingsCache forces a fresh read', async () => {
  globalThis.chrome = makeChromeMock({ extensionEnabled: true });
  bg.invalidateSettingsCache();
  await bg.getSettings();
  bg.invalidateSettingsCache();
  await bg.getSettings();
  assert.equal(globalThis.chrome._state.storageGetCalls, 2);
});

test('getSettings: returns null when storage surfaces an error', async () => {
  const mock = makeChromeMock({ extensionEnabled: true });
  mock._state.nextStorageError = { message: 'storage broken' };
  globalThis.chrome = mock;
  bg.invalidateSettingsCache();
  const s = await bg.getSettings();
  assert.equal(s, null);
});

// ---------------------------------------------------------------------------
// Debug log (#8) — opt-in ring buffer in chrome.storage.session
// ---------------------------------------------------------------------------
test('debug log: truncateForLog shortens long values with an ellipsis', () => {
  assert.equal(bg.truncateForLog('short'), 'short');
  const long = 'a'.repeat(300);
  const t = bg.truncateForLog(long);
  assert.equal(t.length, 201); // 200 chars + ellipsis
  assert.ok(t.endsWith('…'));
  assert.equal(bg.truncateForLog(undefined), '');
});

test('debug log: appendDebugLog is a no-op unless the option is enabled', async () => {
  globalThis.chrome = makeChromeMock({ extensionEnabled: true, customSearchUrl: 'https://d.com/?q=%s' });
  bg.invalidateSettingsCache();
  await bg.getSettings(); // debugLogEnabled defaults to false
  await bg.appendDebugLog('redirect', { engine: 'DuckDuckGo' });
  const entries = await bg.readDebugLog();
  assert.deepEqual(entries, []);
});

test('debug log: enabled option records entries in session storage', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://d.com/?q=%s',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  await bg.getSettings();
  await bg.appendDebugLog('redirect', { engine: 'Google', query: 'hello', unsafeMode: false });
  const entries = await bg.readDebugLog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'redirect');
  assert.equal(entries[0].engine, 'Google');
  // #12: no plaintext search term in the ring buffer — fingerprint only.
  assert.equal(entries[0].query, 'n=5,fp=a430d846');
  assert.ok(!JSON.stringify(entries).includes('hello'), 'no plaintext term anywhere in the entry');
  assert.ok(entries[0].time, 'entry carries a timestamp');
});

test('debug log: ring buffer caps at 200 entries (oldest dropped)', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://d.com/?q=%s',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  await bg.getSettings();
  for (let i = 0; i < 210; i++) {
    await bg.appendDebugLog('redirect', { engine: `E${i}` });
  }
  const entries = await bg.readDebugLog();
  assert.equal(entries.length, 200);
  assert.equal(entries[0].engine, 'E10'); // oldest 10 dropped
  assert.equal(entries[199].engine, 'E209');
});

test('debug log: dropped-entry counter tracks ring-buffer evictions (#19)', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://d.com/?q=%s',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  await bg.getSettings();
  for (let i = 0; i < 210; i++) {
    await bg.appendDebugLog('redirect', { engine: `E${i}` });
  }
  // 210 appended, 200 kept → exactly 10 evicted from the head of the buffer.
  assert.equal(await bg.readDebugLogDroppedCount(), 10);
});

test('debug log: drop counter stays at 0 while the buffer has not overflowed', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://d.com/?q=%s',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  await bg.getSettings();
  for (let i = 0; i < 5; i++) {
    await bg.appendDebugLog('redirect', { engine: `E${i}` });
  }
  assert.equal(await bg.readDebugLogDroppedCount(), 0);
});

test('debug log: clearDebugLog also resets the drop counter', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://d.com/?q=%s',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  await bg.getSettings();
  for (let i = 0; i < 205; i++) {
    await bg.appendDebugLog('redirect', { engine: `E${i}` });
  }
  assert.equal(await bg.readDebugLogDroppedCount(), 5);
  await bg.clearDebugLog();
  assert.deepEqual(await bg.readDebugLog(), []);
  assert.equal(await bg.readDebugLogDroppedCount(), 0);
});

test('debug log: clearDebugLog empties the buffer', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://d.com/?q=%s',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  await bg.getSettings();
  await bg.appendDebugLog('blocked_scheme', { targetUrl: 'javascript:alert(1)' });
  assert.equal((await bg.readDebugLog()).length, 1);
  await bg.clearDebugLog();
  assert.deepEqual(await bg.readDebugLog(), []);
});

test('debug log: handleNavigation logs a redirect when enabled', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://duckduckgo.com/?q=%s',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  await bg.handleNavigation({
    tabId: 3,
    frameId: 0,
    url: 'https://www.google.com/search?q=hello%20world',
  });
  const entries = await bg.readDebugLog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'redirect');
  assert.equal(entries[0].engine, 'Google');
  // #12: the query field is fingerprinted, and the URLs no longer carry the
  // plaintext search term (q= is redacted in both original and target).
  assert.equal(entries[0].query, 'n=11,fp=779a65e7');
  assert.equal(entries[0].unsafeMode, false);
  assert.equal(entries[0].originalUrl, 'https://www.google.com/search?q=%5BREDACTED%5D');
  assert.equal(entries[0].targetUrl, 'https://duckduckgo.com/?q=%5BREDACTED%5D');
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes('hello world'), 'no plaintext search term in any logged URL');
});

test('debug log: blocked-scheme redirect attempts are recorded when enabled', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://duckduckgo.com/?q=%s',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  const ok = await bg.redirectTab(9, 'javascript:alert(1)', 'https://www.google.com/search?q=x');
  assert.equal(ok, false);
  const entries = await bg.readDebugLog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'blocked_scheme');
  // #12: the body of a blocked URL can carry the substituted term in its
  // opaque scheme-specific part — it is fingerprinted, not persisted raw.
  assert.match(entries[0].targetUrl, /^javascript:\[blocked-body n=\d+,fp=[0-9a-f]{8}\]$/);
  assert.ok(!JSON.stringify(entries).includes('alert(1)'), 'no raw body in the persisted entry');
});

// ---------------------------------------------------------------------------
// Debug log redaction (#12) — no plaintext search terms in the ring buffer
// ---------------------------------------------------------------------------
test('fingerprintForLog: is deterministic and sensitive to the input', () => {
  assert.equal(bg.fingerprintForLog('hello'), bg.fingerprintForLog('hello'));
  assert.notEqual(bg.fingerprintForLog('hello'), bg.fingerprintForLog('world'));
  assert.notEqual(bg.fingerprintForLog('a'), bg.fingerprintForLog('b'));
  assert.equal(bg.fingerprintForLog('hello'), 'a430d846');
  // Fixed 8-hex-char shape regardless of input length.
  assert.match(bg.fingerprintForLog('x'.repeat(500)), /^[0-9a-f]{8}$/);
});

test('fingerprintForLog: null/empty yields null, non-strings are coerced', () => {
  assert.equal(bg.fingerprintForLog(''), null);
  assert.equal(bg.fingerprintForLog(null), null);
  assert.equal(bg.fingerprintForLog(undefined), null);
  assert.equal(typeof bg.fingerprintForLog(123), 'string');
});

test('redactQueryForLog: replaces the term with length + fingerprint', () => {
  assert.equal(bg.redactQueryForLog('hello'), 'n=5,fp=a430d846');
  assert.equal(bg.redactQueryForLog(''), '');
  assert.equal(bg.redactQueryForLog(null), '');
  // The plaintext term never appears in the redacted form.
  assert.ok(!bg.redactQueryForLog('confidential search').includes('confidential'));
});

test('redactSensitiveUrlParams: redacts credential-looking parameters', () => {
  const out = bg.redactSensitiveUrlParams(
    'https://e.com/p?token=abc123&key=xyz&sid=99&code=oauth&sid2=ok&foo=bar'
  );
  assert.ok(out.includes('token=%5BREDACTED%5D'));
  assert.ok(out.includes('key=%5BREDACTED%5D'));
  assert.ok(out.includes('sid=%5BREDACTED%5D'));
  assert.ok(out.includes('code=%5BREDACTED%5D'));
  assert.ok(!out.includes('abc123') && !out.includes('xyz') && !out.includes('oauth'));
  // Innocuous parameters (including the lookalike sid2) are untouched.
  assert.ok(out.includes('foo=bar'));
  assert.ok(out.includes('sid2=ok'));
});

test('redactSensitiveUrlParams: redacts search-query parameters (no term re-leak)', () => {
  const g = bg.redactSensitiveUrlParams('https://google.com/search?q=hello');
  assert.ok(g.includes('q=%5BREDACTED%5D'));
  assert.ok(!g.includes('hello'));
  assert.ok(bg.redactSensitiveUrlParams('https://baidu.com/s?wd=x').includes('wd=%5BREDACTED%5D'));
  assert.ok(bg.redactSensitiveUrlParams('https://yandex.com/search/?text=x').includes('text=%5BREDACTED%5D'));
});

test('redactSensitiveUrlParams: case-insensitive, leaves clean URLs untouched', () => {
  assert.ok(bg.redactSensitiveUrlParams('https://e.com/?TOKEN=Up').includes('TOKEN=%5BREDACTED%5D'));
  const clean = 'https://e.com/page?a=1&b=2';
  assert.equal(bg.redactSensitiveUrlParams(clean), clean);
  // Non-URL / empty inputs pass through unchanged (no throw).
  assert.equal(bg.redactSensitiveUrlParams('not a url'), 'not a url');
  assert.equal(bg.redactSensitiveUrlParams(''), '');
  assert.equal(bg.redactSensitiveUrlParams(null), null);
});

test('#94: redactSensitiveUrlParams drops userinfo credentials (user:pass@host)', () => {
  const out = bg.redactSensitiveUrlParams('https://user:hunter2@google.com/?q=x');
  assert.ok(!out.includes('hunter2'), 'password must not survive');
  assert.ok(!out.includes('user@'), 'userinfo (incl. the @ separator) must be dropped');
  assert.equal(out, 'https://google.com/?q=%5BREDACTED%5D');
  // Username-only userinfo is dropped too.
  assert.equal(bg.redactSensitiveUrlParams('https://user@google.com/a'), 'https://google.com/a');
});

test('#94: redactSensitiveUrlParams redacts credential-looking fragment params', () => {
  const out = bg.redactSensitiveUrlParams(
    'https://example.com/app#access_token=abc123&state=y'
  );
  assert.ok(!out.includes('abc123'), 'hash token must not survive');
  assert.ok(out.includes('access_token=%5BREDACTED%5D'));
  // state= is not a sensitive name — it stays, so the entry remains readable.
  assert.ok(out.includes('state=y'));
  // A plain anchor fragment has no params: input returned byte-identical.
  const anchor = 'https://e.com/page#section-2';
  assert.equal(bg.redactSensitiveUrlParams(anchor), anchor);
  // Query + fragment together: both locations redacted in one pass.
  const both = bg.redactSensitiveUrlParams(
    'https://e.com/p?token=t1&q=term#code=hash123'
  );
  assert.ok(!both.includes('t1') && !both.includes('term') && !both.includes('hash123'));
});

test('redactSensitiveUrlParams: unparseable URLs get best-effort redaction, not passthrough (#95)', () => {
  // The parseable path cannot help here — `new URL()` throws, so the
  // helper falls back to raw-string redaction of the same param names at
  // real boundaries (? / & / #) instead of returning the input verbatim.
  // Out-of-range port is what makes these unparseable while still looking
  // like real search URLs.
  const out = bg.redactSensitiveUrlParams('https://google.com:99999/search?q=term&x=1');
  assert.ok(!out.includes('term'), 'the query term must not survive the fallback');
  assert.ok(out.includes('q=[REDACTED]'));
  assert.ok(out.includes('x=1'), 'innocuous params are untouched');
  // Every occurrence is redacted, and fragment params at # boundaries too.
  const multi = bg.redactSensitiveUrlParams('https://e.com:99999/p?q=a&q=b#code=hash1');
  assert.ok(!multi.includes('a=') && !multi.includes('hash1'));
  assert.ok(multi.includes('q=[REDACTED]&q=[REDACTED]'));
  assert.ok(multi.includes('#code=[REDACTED]'));
  // Case-insensitive, like the parseable path.
  assert.ok(bg.redactSensitiveUrlParams('https://e.com:99999/?TOKEN=Abc').includes('TOKEN=[REDACTED]'));
  // A boundary char is required: `notq=1` and `monkey=1` contain the names
  // as substrings but not as params — they must survive.
  const lookalike = bg.redactSensitiveUrlParams('https://e.com:99999/?notq=1&monkey=2');
  assert.ok(lookalike.includes('notq=1') && lookalike.includes('monkey=2'));
  // No boundaries at all -> unchanged (the "not a url" passthrough is kept).
  assert.equal(bg.redactSensitiveUrlParams('not a url'), 'not a url');
});

test('#95: the extractSearchQuery catch path redacts the unparseable URL', () => {
  // The catch fires exactly when `new URL(url)` throws. Port 99999 makes
  // the parser reject the URL while it still looks like a Google search
  // URL carrying its term — drive the real catch path and assert the
  // console line honours the #12 contract.
  const google = bg.searchEngines.find((e) => e.name === 'Google');
  const secret = 'catchsecret7';
  const cap = captureConsole();
  let result;
  try {
    result = bg.extractSearchQuery(
      `https://www.google.com:99999/search?q=${secret}&token=rawtok`,
      google
    );
  } finally {
    cap.restore();
  }
  assert.equal(result, null);
  const line = cap.seen.error.find((l) => l.includes('Failed to extract search query'));
  assert.ok(line, 'the catch line was logged at error');
  assert.ok(!line.includes(secret), 'the plaintext term must not reach the console');
  assert.ok(!line.includes('rawtok'), 'the credential param value must not reach the console');
  assert.ok(line.includes('[REDACTED]'), 'the fallback redaction is visible in the line');
});

test('redactDebugEntry: redacts query + both URL fields in place', () => {
  const entry = bg.redactDebugEntry({
    event: 'redirect',
    query: 'hello world',
    originalUrl: 'https://www.google.com/search?q=hello%20world&token=secret1',
    targetUrl: 'https://duckduckgo.com/?q=hello%20world',
  });
  assert.equal(entry.query, 'n=11,fp=779a65e7');
  assert.ok(!JSON.stringify(entry).includes('hello'));
  assert.ok(!JSON.stringify(entry).includes('secret1'));
  // Non-redirect entries without a query field are left structurally intact.
  const blocked = bg.redactDebugEntry({ event: 'blocked_scheme', targetUrl: 'javascript:alert(1)' });
  // The scheme survives (the security signal), the body is fingerprinted
  // (#12) — a blocked URL's term hides in its opaque scheme-specific part.
  assert.equal(blocked.targetUrl, 'javascript:[blocked-body n=8,fp=e1e3bcaa]');
  assert.equal(blocked.query, undefined);
});

test('redactBlockedUrl: fingerprints the opaque body of blocked-scheme URLs (#12)', () => {
  // A `%s` template like `javascript:alert(%s)` becomes `javascript:alert(<term>)`;
  // the term sits in the scheme-specific body, where param-redaction can't reach.
  const out = bg.redactBlockedUrl('javascript:alert(top-secret-term)');
  assert.match(out, /^javascript:\[blocked-body n=\d+,fp=[0-9a-f]{8}\]$/);
  assert.ok(!out.includes('top-secret-term'), 'plaintext body must not survive');
});

test('redactBlockedUrl: data: URLs are redacted the same way', () => {
  const out = bg.redactBlockedUrl('data:text/html,<script>steal(' + 'my-token-value' + ')</script>');
  assert.match(out, /^data:\[blocked-body n=\d+,fp=[0-9a-f]{8}\]$/);
  assert.ok(!out.includes('my-token-value'));
});

test('redactBlockedUrl: non-blocked URLs fall through to param redaction (total function)', () => {
  // Safe URLs keep scheme + host, but credential-looking params are still
  // stripped — and the bracket token is percent-encoded on URL re-serialization.
  const out = bg.redactBlockedUrl('https://duckduckgo.com/?q=hello&api_key=K1');
  assert.ok(out.startsWith('https://duckduckgo.com/?'), 'scheme + host are preserved');
  assert.ok(!out.includes('K1'), 'the credential param value must not survive');
  assert.ok(out.includes('api_key=%5BREDACTED%5D'), 'the credential is redacted in place');
  // A term in a plain query param is still redacted by the #12 param pass.
  const g = bg.redactBlockedUrl('https://www.google.com/search?q=top-secret-term');
  assert.ok(!g.includes('top-secret-term'), 'the term in the param must not survive');
  // Bare scheme with no body: nothing to redact.
  assert.equal(bg.redactBlockedUrl('javascript:'), 'javascript:');
});

test('redactBlockedUrl: idempotent through redactSensitiveUrlParams (persist re-run)', () => {
  // redactDebugEntry re-runs redactSensitiveUrlParams-style paths downstream;
  // the fingerprint form must not be mangled into a second redaction.
  const once = bg.redactBlockedUrl('javascript:alert(1)');
  const twice = bg.redactSensitiveUrlParams(once);
  assert.equal(twice, once, 'second pass must leave the fingerprinted form intact');
});

// ---------------------------------------------------------------------------
// redactTermFromUrl — a %s template can embed the term in the URL PATH
// (https://example.com/search/%s), where param-level redaction is blind.
// ---------------------------------------------------------------------------
test('redactTermFromUrl: strips a path-embedded term, keeping host + path base (#12 path variant)', () => {
  const term = 'my top secret';
  const target = bg.createTargetUrl('https://example.com/search/%s', term, false);
  assert.equal(target, 'https://example.com/search/my%20top%20secret');
  const out = bg.redactTermFromUrl(target, term);
  assert.equal(out, 'https://example.com/search/[REDACTED]');
  assert.ok(!out.includes(term), 'plaintext term must not survive');
  assert.ok(!out.includes(encodeURIComponent(term)), 'encoded term must not survive');
  assert.ok(out.includes('example.com'), 'the host must stay intact');
  assert.ok(out.includes('/search/'), 'the path base must stay intact');
});

test('redactTermFromUrl: a short/common term must not corrupt the host or other segments', () => {
  // A 1-char term must not turn "example.com" into "exampl[REDACTED].com" —
  // redaction is boundary-bounded to the substituted path segment.
  const out = bg.redactTermFromUrl('https://example.com/search/a', 'a');
  assert.ok(out.includes('example.com'), 'the host must not be mangled by a 1-char term');
  assert.ok(!out.includes('exampl[REDACTED]') && !out.includes('examle'), 'no host corruption');
  assert.ok(out.includes('[REDACTED]') || !out.includes('/search/a'), 'the segment is stripped');
  // A term that only appears as a substring of the host (no boundary) is untouched.
  assert.equal(
    bg.redactTermFromUrl('https://example.com/search/zzz', 'exam'),
    'https://example.com/search/zzz',
    'a host-substring term without a boundary must not be redacted'
  );
});

test('redactTermFromUrl: a ?q= template still redacts to the percent-encoded bracket token', () => {
  // The existing #91/#12 behaviour is preserved: the q param value becomes
  // [REDACTED], and URL re-serialization percent-encodes the brackets.
  const out = bg.redactTermFromUrl(
    bg.createTargetUrl('https://duckduckgo.com/?q=%s', 'hello world', false),
    'hello world'
  );
  assert.equal(out, 'https://duckduckgo.com/?q=%5BREDACTED%5D');
});

test('redactTermFromUrl: blocked-scheme URLs delegate to the opaque-body fingerprint', () => {
  // `javascript:alert(%s)` hides the term in the scheme-specific body, where
  // path-segment stripping can't reach — delegate to redactBlockedUrl instead.
  const term = 'my top secret';
  const target = bg.createTargetUrl('javascript:alert(%s)', term, true);
  const out = bg.redactTermFromUrl(target, term);
  assert.equal(out, bg.redactBlockedUrl(target));
  assert.match(out, /^javascript:\[blocked-body n=\d+,fp=[0-9a-f]{8}\]$/);
  assert.ok(!out.includes(term));
});

test('redactTermFromUrl: idempotent (a second pass is a no-op)', () => {
  const term = 'my top secret';
  const target = bg.createTargetUrl('https://example.com/search/%s', term, false);
  const once = bg.redactTermFromUrl(target, term);
  assert.equal(bg.redactTermFromUrl(once, term), once, 'path form must be stable');
  const js = bg.createTargetUrl('javascript:alert(%s)', term, true);
  const onceJs = bg.redactTermFromUrl(js, term);
  assert.equal(bg.redactTermFromUrl(onceJs, term), onceJs, 'blocked-body form must be stable');
});

test('redactTermFromUrl: is a strict superset of param redaction (named creds still stripped)', () => {
  const out = bg.redactTermFromUrl('https://e.com/search/x?api_key=K1&q=hello', 'hello');
  assert.ok(out.includes('api_key=%5BREDACTED%5D'), 'the credential param is redacted in place');
  assert.ok(!out.includes('K1'), 'the credential value must not survive');
});

test('redactTermFromUrl: empty/missing term and absent term are no-ops', () => {
  // No term -> plain param redaction (total function, safe at any sink).
  assert.equal(
    bg.redactTermFromUrl('https://e.com/?q=hello', ''),
    bg.redactSensitiveUrlParams('https://e.com/?q=hello')
  );
  assert.equal(bg.redactTermFromUrl(null, 'x'), null, 'null url passes through');
  assert.equal(bg.redactTermFromUrl(undefined, 'x'), undefined, 'undefined url passes through');
  assert.equal(
    bg.redactTermFromUrl('https://e.com/path/xyz', 'zzz-not-here'),
    'https://e.com/path/xyz',
    'an absent term must not alter the url (no false positive)'
  );
});

test('redactTermFromUrl: the leading boundary set redacts exactly at start, and only there (#98)', () => {
  // #98 replaced the lookbehind leading anchor with a captured group.
  // safari-lookbehind-floor.test.js pins the SYNTAX (no lookbehind ships, so
  // the Safari 14.0 floor holds); this pins the BEHAVIOUR of the replacement
  // anchor: it must redact a bare term at exactly the same 7 boundary chars
  // the old lookbehind encoded (^ / ? # & = ; +) — and refuse to redact a
  // term that sits mid-segment (no leading boundary). Bare terms and a
  // non-sensitive param name (x) are used so that ONLY the boundary anchor —
  // not redactSensitiveUrlParams — can be doing the redacting. Verified
  // byte-equivalent to the original lookbehind's runtime class before pinning.
  const term = 'zebra';
  const boundaryCases = {
    '/  (path segment start)':  'https://e.com/zebra',
    '?  (bare query start)':    'https://e.com/x?zebra',
    '#  (bare fragment start)': 'https://e.com/x#zebra',
    '&  (param separator)':     'https://e.com/?a=1&zebra',
    ';  (semi separator)':      'https://e.com/?a=1;zebra',
    '+  (plus separator)':      'https://e.com/?a+zebra',
    '=  (param value start)':   'https://e.com/?x=zebra',
  };
  for (const [label, url] of Object.entries(boundaryCases)) {
    const out = bg.redactTermFromUrl(url, term);
    assert.ok(out.includes('[REDACTED]'), `${label}: boundary term must be redacted — got ${out}`);
    assert.ok(!out.includes(term), `${label}: plaintext term must not survive — got ${out}`);
  }
  // Control: no leading boundary -> untouched. A term embedded mid-segment
  // (preceded AND followed by non-boundary chars) must not be redacted.
  assert.equal(
    bg.redactTermFromUrl('https://e.com/aze', 'ze'),
    'https://e.com/aze',
    'a mid-segment term (no leading boundary) must not be redacted'
  );
  assert.equal(
    bg.redactTermFromUrl('https://e.com/zebrax', term),
    'https://e.com/zebrax',
    'a term with a trailing continuation char (no trailing boundary) must not be redacted'
  );
});

test('redactBlockedUrl: idempotent across its own marker (a second redact pass is a no-op)', () => {
  // redactDebugEntry re-runs redaction on the persisted form; a second
  // redactBlockedUrl pass must not re-fingerprint the [blocked-body …] marker.
  const once = bg.redactBlockedUrl('javascript:alert(1)');
  assert.equal(bg.redactBlockedUrl(once), once, 're-running must leave the marker intact');
});

test('path-embedded term: the plaintext term never reaches the console mirror or the ring buffer', async () => {
  // End-to-end real flow: a PATH-based %s template puts the search term in the
  // target's path (https://example.com/search/<term>), where param-level
  // redaction is blind. Both the unconditional console mirror and the opt-in
  // ring buffer must surface it redacted (#12 contract, both sinks).
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://example.com/search/%s',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  const term = 'my top secret';
  const cap = captureConsole();
  try {
    await bg.handleNavigation({
      tabId: 13,
      frameId: 0,
      url: `https://www.google.com/search?q=${encodeURIComponent(term)}`,
    });
  } finally {
    cap.restore();
  }
  const line = cap.seen.log.find((l) => l.includes('Redirecting Tab 13'));
  assert.ok(line, 'the console mirror fired for the redirect');
  assert.ok(!line.includes(term), 'the plaintext term must not reach the console');
  assert.ok(!line.includes(encodeURIComponent(term)), 'the encoded term must not reach the console');
  assert.ok(line.includes('[REDACTED]'), 'the target path carries the redaction token');
  const entries = await bg.readDebugLog();
  const e = entries.find((x) => x.event === 'redirect');
  assert.ok(e, 'the ring buffer recorded the redirect');
  assert.equal(e.targetUrl, 'https://example.com/search/[REDACTED]');
  assert.ok(!e.targetUrl.includes(encodeURIComponent(term)), 'the encoded term must not be persisted');
  const serialized = JSON.stringify(e);
  assert.ok(!serialized.includes(term), 'the plaintext term must not be persisted');
  assert.ok(!serialized.includes(encodeURIComponent(term)), 'the encoded term must not be persisted');
});

test('redirectTab: the identical-URL abort line redacts a path-embedded term', async () => {
  // The #91 abort line fires with the full URL; a path-embedded term must not
  // reach the console — redactTermFromUrl(targetUrl, searchQuery) strips it.
  const cap = captureConsole();
  try {
    const url = 'https://example.com/search/my%20top%20secret';
    const ok = await bg.redirectTab(9, url, url, 'my top secret');
    assert.equal(ok, false);
    assert.equal(globalThis.chrome._state.tabsUpdateCalls.length, 0);
    const line = cap.seen.warn.find((l) => l.includes('identical to original URL'));
    assert.ok(line, 'the abort console line fired');
    assert.ok(!line.includes('my top secret'), 'the plaintext term must not reach the console');
    assert.ok(!line.includes('my%20top%20secret'), 'the encoded term must not reach the console');
  } finally {
    cap.restore();
  }
});

test('redirectTab: a failing redirect redacts a path-embedded term in the catch line', async () => {
  // The #91 catch line fires with the full target URL on error; a path-embedded
  // term must not reach the console — redactTermFromUrl(targetUrl, searchQuery).
  globalThis.chrome.tabs.update = () => Promise.reject(new Error('boom'));
  const cap = captureConsole();
  try {
    const ok = await bg.redirectTab(
      9,
      'https://example.com/search/my%20top%20secret',
      'https://www.google.com/search?q=other',
      'my top secret'
    );
    assert.equal(ok, false);
    const line = cap.seen.error.find((l) => l.includes('Failed to redirect tab 9'));
    assert.ok(line, 'the catch console line fired');
    assert.ok(!line.includes('my top secret'), 'the plaintext term must not reach the console');
    assert.ok(!line.includes('my%20top%20secret'), 'the encoded term must not reach the console');
  } finally {
    cap.restore();
  }
});

test('blocked-scheme sink: the plaintext term never reaches the console mirror or the ring buffer', async () => {
  // End-to-end real flow: a `javascript:` template makes createTargetUrl embed
  // the search term in the target's opaque scheme-specific body
  // (`javascript:alert(%s)` → `javascript:alert(<term>)`); the final sink guard
  // in redirectTab then refuses it. Both the unconditional console mirror and
  // the opt-in ring buffer must surface it redacted (#12 contract, both sinks).
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'javascript:alert(%s)',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  const term = 'my top secret';
  const cap = captureConsole();
  try {
    await bg.handleNavigation({
      tabId: 7,
      frameId: 0,
      url: `https://www.google.com/search?q=${encodeURIComponent(term)}`,
    });
  } finally {
    cap.restore();
  }
  const warnLine = cap.seen.warn.find((l) => l.includes('BLOCKED redirect target'));
  assert.ok(warnLine, 'the console mirror fired for the blocked scheme');
  assert.ok(warnLine.includes('javascript:'), 'the scheme (security signal) is preserved');
  assert.match(warnLine, /blocked-body n=\d+,fp=[0-9a-f]{8}/, 'the body is fingerprinted');
  assert.ok(!warnLine.includes(term), 'the plaintext term must not reach the console');
  assert.ok(!warnLine.includes(encodeURIComponent(term)), 'the encoded term must not reach the console');
  const entries = await bg.readDebugLog();
  const blocked = entries.find((e) => e.event === 'blocked_scheme');
  assert.ok(blocked, 'the ring buffer recorded the blocked attempt');
  assert.match(blocked.targetUrl, /^javascript:\[blocked-body n=\d+,fp=[0-9a-f]{8}\]$/);
  const serialized = JSON.stringify(blocked);
  assert.ok(!serialized.includes(term), 'the plaintext term must not be persisted');
  assert.ok(!serialized.includes(encodeURIComponent(term)), 'the encoded term must not be persisted');
});

test('debug log: appendDebugLog persists redacted entries even via direct calls', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://d.com/?q=%s',
    debugLogEnabled: true,
  });
  bg.invalidateSettingsCache();
  await bg.getSettings();
  await bg.appendDebugLog('redirect', {
    engine: 'Google',
    query: 'my bank account password',
    targetUrl: 'https://d.com/?q=my%20bank%20account%20password&api_key=K123',
  });
  const entries = await bg.readDebugLog();
  assert.equal(entries.length, 1);
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes('my bank account password'), 'plaintext term must not be persisted');
  assert.ok(!serialized.includes('K123'), 'credential-looking param must not be persisted');
  assert.match(entries[0].query, /^n=\d+,fp=[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// README vs pbxproj drift guard (#11) — the documented macOS floor must match
// the build target, or a user is told a lie before they install.
// ---------------------------------------------------------------------------
test('macOS floor: README matches MACOSX_DEPLOYMENT_TARGET in the pbxproj', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const pbx = readFileSync(path.join(root, 'QueryHop.xcodeproj', 'project.pbxproj'), 'utf8');

  // What the README claims (Requirements section).
  const readmeFloor = readme.match(/macOS\s+(\d+\.\d+)\+/);
  assert.ok(readmeFloor, 'README must state a "macOS X.Y+" floor in Requirements');

  // What the build actually targets. Per-target blocks declare a
  // PRODUCT_BUNDLE_IDENTIFIER; the project-level defaults (15.3 today) do
  // not. Both shipped products (app + extension) must agree on one floor.
  const targetFloors = new Set();
  const blockRe = /buildSettings\s*=\s*{([\s\S]*?)};/g;
  let m;
  while ((m = blockRe.exec(pbx)) !== null) {
    const block = m[1];
    const floorMatch = block.match(/MACOSX_DEPLOYMENT_TARGET\s*=\s*(\d+\.\d+)/);
    if (floorMatch && /PRODUCT_BUNDLE_IDENTIFIER/.test(block)) {
      targetFloors.add(floorMatch[1]);
    }
  }
  assert.equal(
    targetFloors.size, 1,
    `app + extension must share one MACOSX_DEPLOYMENT_TARGET, got: ${[...targetFloors].join(', ') || '(none found)'}`
  );
  const buildFloor = [...targetFloors][0];
  assert.equal(
    readmeFloor[1], buildFloor,
    `README says macOS ${readmeFloor[1]}+ but the build target is ${buildFloor} — update one or the other and keep them in lockstep.`
  );
});

// ---------------------------------------------------------------------------
// logMessage level routing (#89) — warn must not collapse onto console.log
// ---------------------------------------------------------------------------
test('logMessage: log/warn/error each route to their own console method', () => {
  const seen = { log: [], warn: [], error: [] };
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const method of ['log', 'warn', 'error']) {
    console[method] = (...args) => seen[method].push(args);
  }
  try {
    logMessage('log', 'routine line');
    logMessage('warn', 'degraded path', { detail: 1 });
    logMessage('error', 'boom', new Error('kaboom'));
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  assert.equal(seen.log.length, 1, 'log routes to console.log');
  assert.equal(seen.warn.length, 1, 'warn routes to console.warn, not console.log');
  assert.equal(seen.error.length, 1, 'error routes to console.error');
  // The timestamp/source prefix is preserved for every level.
  for (const method of ['log', 'warn', 'error']) {
    assert.match(
      seen[method][0][0],
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[Background\]$/
    );
  }
  assert.equal(seen.warn[0][1], 'degraded path');
});

test('logMessage: an unknown or missing level falls back to log (never console[undefined])', () => {
  const seen = { log: [], warn: [], error: [] };
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const method of ['log', 'warn', 'error']) {
    console[method] = (...args) => seen[method].push(args);
  }
  try {
    logMessage('speak', 'unknown level');
    logMessage(undefined, 'missing level');
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  assert.equal(seen.log.length, 2, 'both fall back to console.log');
  assert.equal(seen.warn.length, 0);
  assert.equal(seen.error.length, 0);
});

// ---------------------------------------------------------------------------
// #91 — the #12 redaction contract must hold on the CONSOLE path, not just
// the ring buffer. Each case drives the real code path and asserts no
// console line (log/warn/error) carries the distinctive query token.
// ---------------------------------------------------------------------------
function captureConsole() {
  const seen = { log: [], warn: [], error: [] };
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const method of ['log', 'warn', 'error']) {
    console[method] = (...args) => seen[method].push(args.join(' '));
  }
  return {
    seen,
    restore() {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
    all() {
      return [...seen.log, ...seen.warn, ...seen.error].join('\n');
    },
  };
}

test('#91: the detected-query console line is fingerprinted, never plaintext', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://duckduckgo.com/?q=%s',
  });
  bg.invalidateSettingsCache();
  const secret = 'zebra42quantum';
  const cap = captureConsole();
  try {
    await bg.handleNavigation({
      tabId: 5,
      frameId: 0,
      url: `https://www.google.com/search?q=${encodeURIComponent(secret)}`,
    });
  } finally {
    cap.restore();
  }
  assert.ok(!cap.all().includes(secret), 'no console line may carry the plaintext query');
  const detected = cap.seen.log.find((l) => l.includes('Search query detected'));
  assert.ok(detected, 'the detected-query line was logged');
  assert.match(detected, /n=\d+,fp=[0-9a-f]{8}/, 'the term is fingerprinted (n=len,fp=…), not printed');
});

test('#91: the Redirecting Tab console line redacts query params in both URLs', async () => {
  globalThis.chrome = makeChromeMock({
    extensionEnabled: true,
    customSearchUrl: 'https://duckduckgo.com/?q=%s',
  });
  bg.invalidateSettingsCache();
  const secret = 'secretterm9';
  const cap = captureConsole();
  try {
    await bg.handleNavigation({
      tabId: 8,
      frameId: 0,
      url: `https://www.google.com/search?q=${encodeURIComponent(secret)}`,
    });
  } finally {
    cap.restore();
  }
  const line = cap.seen.log.find((l) => l.includes('Redirecting Tab 8'));
  assert.ok(line, 'the redirect line was logged');
  assert.ok(!line.includes(secret), 'the plaintext term must not appear in the URL prefixes');
  // URLSearchParams percent-encodes the brackets when serializing the URL.
  assert.ok(line.includes('%5BREDACTED%5D'), 'the query params are redacted in place');
});

test('#91: the extractSearchQuery fallback warn line redacts the URL', () => {
  const google = bg.searchEngines.find((e) => e.name === 'Google');
  const secret = 'loosequery77';
  const cap = captureConsole();
  let result;
  try {
    // Engine pattern matches (it is a Google search URL) but the engine's
    // `q` param is absent — the term sits in a synonym param, which is
    // exactly the URL-shape-drift case the fallback exists for.
    result = bg.extractSearchQuery(`https://www.google.com/search?query=${secret}`, google);
  } finally {
    cap.restore();
  }
  assert.equal(result, null);
  const line = cap.seen.warn.find((l) => l.includes('Could not find query parameter(s)'));
  assert.ok(line, 'the fallback warn line was logged');
  assert.ok(!line.includes(secret), 'the full URL must not leak the term at warn');
  assert.ok(line.includes('%5BREDACTED%5D'));
});

test('#91: the encode-failure console line redacts the term', () => {
  // encodeURIComponent throws URIError on a lone surrogate — the catch path
  // used to interpolate the raw term into the console.
  const term = `top\u{D800}secret`;
  const cap = captureConsole();
  let result;
  try {
    result = bg.createTargetUrl('https://duckduckgo.com/?q=%s', term, false);
  } finally {
    cap.restore();
  }
  assert.equal(result, null);
  const line = cap.seen.error.find((l) => l.includes('Failed to encode search query'));
  assert.ok(line, 'the encode-failure line was logged');
  assert.ok(!line.includes(term), 'the raw term must not appear');
  assert.match(line, /n=\d+,fp=[0-9a-f]{8}/, 'the term is fingerprinted, not printed');
});

// ---------------------------------------------------------------------------
// #92 — the LOG_MESSAGE relay (popup -> worker) is a boundary: `level` is an
// unvalidated message field and must go through consoleMethodFor.
// ---------------------------------------------------------------------------
const relayListener = importMock._state.onMessageListeners[0];

test('#92: the LOG_MESSAGE relay routes known levels to their console method', () => {
  assert.ok(typeof relayListener === 'function', 'the onMessage listener is registered at import');
  const cap = captureConsole();
  try {
    const send = (level, message, data = null) =>
      relayListener(
        { type: 'LOG_MESSAGE', payload: { level, message, data, source: 'popup', timestamp: '2026-10-08T00:00:00.000Z' } },
        {},
        () => {}
      );
    send('error', 'boom');
    send('warn', 'degraded');
    send('log', 'routine');
    send('log', 'with data', JSON.stringify({ a: 1 }));
  } finally {
    cap.restore();
  }
  assert.equal(cap.seen.error.length, 1);
  assert.equal(cap.seen.warn.length, 1);
  assert.equal(cap.seen.log.length, 2);
  assert.ok(cap.seen.error[0].startsWith('[2026-10-08T00:00:00.000Z] [popup] boom'));
  assert.ok(cap.seen.log[1].includes('[2026-10-08T00:00:00.000Z] [popup] with data'));
});

test('#92: the LOG_MESSAGE relay never throws and unknown levels fall back to log', () => {
  const cap = captureConsole();
  try {
    const send = (level, message) =>
      relayListener(
        { type: 'LOG_MESSAGE', payload: { level, message, data: null, source: 'popup', timestamp: '2026-10-08T00:00:00.000Z' } },
        {},
        () => {}
      );
    // The boundary case the issue calls out: a hostile/buggy popup can send
    // any level string — console[level] must never be console[undefined].
    assert.doesNotThrow(() => send('speak-loud', 'unknown level'));
    assert.doesNotThrow(() => send(undefined, 'missing level'));
    assert.doesNotThrow(() => send('', 'empty level'));
  } finally {
    cap.restore();
  }
  assert.equal(cap.seen.log.length, 3, 'all unknown levels fall back to console.log');
  assert.equal(cap.seen.warn.length, 0);
  assert.equal(cap.seen.error.length, 0);
});
