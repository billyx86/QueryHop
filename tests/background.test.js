// Unit tests for the pure redirect/validation logic in
// QueryHop Extension/Resources/background.js.
//
// Run with `node --test` (see package.json). The extension background script
// references the `chrome` global, which does not exist under Node — so we
// install a controllable mock on globalThis BEFORE importing the module. The
// exported functions resolve `chrome` from the global at call time, so we can
// swap the mock per test.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeChromeMock(stored = {}) {
  const state = {
    storage: { ...stored },
    storageGetCalls: 0,
    tabsUpdateCalls: [],
    nextStorageError: null,
  };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
    },
    webNavigation: {
      onBeforeNavigate: { addListener() {} },
    },
    storage: {
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

// Import-time chrome usage is only the two addListener calls, so a bare mock
// is enough here. Per-test tests reassign globalThis.chrome as needed.
globalThis.chrome = makeChromeMock();

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
