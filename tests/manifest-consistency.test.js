// Invariant tests: the engine URL patterns in background.js must stay in
// sync with the host_permissions in manifest.json.
//
// The webNavigation listener is filtered by the engine patterns, but the
// extension can only OBSERVE (and therefore redirect) hosts it has a
// host_permission for. So any engine pattern that matches a host outside
// host_permissions is dead weight — and worse, it hides drift: the day a
// pattern is widened (or a host_permission is dropped) the extension silently
// stops redirecting on some TLDs. This test fails the build on that drift.
//
// It parses both files as text (no module import) so it runs with plain
// `node --test` and never needs the `chrome` API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'QueryHop Extension/Resources/manifest.json');
const backgroundPath = path.join(root, 'QueryHop Extension/Resources/background.js');

assert.ok(fs.existsSync(manifestPath), 'manifest.json is missing');
assert.ok(fs.existsSync(backgroundPath), 'background.js is missing');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const background = fs.readFileSync(backgroundPath, 'utf8');
const hostPermissions = manifest.host_permissions || [];

// Turn a host_permissions pattern like "*://*.google.com/*" or
// "*://*.bing.com/search*" into a predicate over a hostname.
// A leading "*." means "the base domain or any subdomain" — so
// "*.google.com" matches both "google.com" and "www.google.com" (but not
// "notgoogle.com").
function hostMatcher(pattern) {
  const m = pattern.match(/^\*:\/\/([^/]+)(\/.*)?$/);
  assert.ok(m, `unparseable host_permission: ${pattern}`);
  const hostPat = m[1];
  let base;
  if (hostPat.startsWith('*.')) {
    base = hostPat.slice(2);
  } else if (hostPat === '*') {
    base = null; // matches any host
  } else {
    base = hostPat;
  }
  if (base === null) return () => true;
  return new RegExp(`^(?:.*\\.)?${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

const matchers = hostPermissions.map(hostMatcher);
function hostAllowed(host) {
  return matchers.some((r) => r.test(host));
}

// The seven engine patterns, extracted from background.js as text.
const engines = [];
const engineBlock = background.match(/const searchEngines = \[([\s\S]*?)\];/);
assert.ok(engineBlock, 'could not find the searchEngines array in background.js');
const entryRe = /\{\s*pattern:\s*\/(.+?)\/\s*,\s*queryParam:/g;
let em;
while ((em = entryRe.exec(engineBlock[1]))) {
  engines.push({ pattern: new RegExp(`^${em[1]}$`) });
}
assert.equal(engines.length, 7, 'expected 7 engine patterns in background.js');

test('manifest declares a non-empty host_permissions list', () => {
  assert.ok(hostPermissions.length >= 5, 'expected several host_permissions');
});

test('background.js still contains the scheme-denylist guard', () => {
  assert.ok(background.includes('isBlockedScheme'), 'isBlockedScheme guard is gone');
});

test('every engine regex only matches hosts covered by host_permissions', () => {
  // Build sample search URLs from the TLDs the manifest actually permits and
  // assert two things per engine:
  //   1. it still matches every in-permission host it is meant to cover
  //   2. it does NOT match a host that no host_permission covers
  for (const engine of engines) {
    const src = engine.pattern.source;
    let bases;          // allowed base domains the engine should cover
    let fakeTld;        // a TLD the manifest does NOT grant

    if (/google/.test(src)) {
      bases = ['google.com', 'google.co.uk', 'google.de', 'google.fr', 'google.ca', 'google.com.au', 'google.com.br', 'google.co.in', 'google.co.jp', 'google.es', 'google.it', 'google.nl'];
      fakeTld = 'google.ru';
    } else if (/yandex/.test(src)) {
      bases = ['yandex.ru', 'yandex.kz', 'yandex.by', 'yandex.com', 'yandex.com.tr'];
      fakeTld = 'yandex.de';
    } else if (/duckduckgo/.test(src)) {
      bases = ['duckduckgo.com'];
      fakeTld = null;
    } else if (/bing/.test(src)) {
      bases = ['bing.com', 'www.bing.com'];
      fakeTld = 'bing.org';
    } else if (/ecosia/.test(src)) {
      bases = ['ecosia.org'];
      fakeTld = 'ecosia.com';
    } else if (/baidu/.test(src)) {
      bases = ['baidu.com'];
      fakeTld = 'baidu.cn';
    } else if (/yahoo/.test(src)) {
      bases = ['search.yahoo.com'];
      fakeTld = 'search.yahoo.net';
    } else {
      throw new Error(`no host mapping for engine: ${src}`);
    }

    const urlFor = (host) => {
      if (/duckduckgo/.test(src)) return `https://${host}/?q=x`;
      if (/bing/.test(src)) return `https://${host}/search?q=x`;
      if (/ecosia/.test(src)) return `https://${host}/search?q=x`;
      if (/baidu/.test(src)) return `https://${host}/s?wd=x`;
      if (/yahoo/.test(src)) return `https://${host}/search?p=x`;
      if (/yandex/.test(src)) return `https://${host}/search/?text=x`;
      return `https://${host}/search?q=x`; // google
    };

    for (const host of bases) {
      const url = urlFor(host);
      assert.ok(engine.pattern.test(url), `engine should match in-permission ${url}`);
      assert.ok(hostAllowed(host), `host_permissions must cover ${host} (matched by engine)`);
    }

    if (fakeTld) {
      const badUrl = urlFor(fakeTld);
      assert.ok(!engine.pattern.test(badUrl), `engine must NOT match out-of-permission ${badUrl}`);
      assert.ok(!hostAllowed(new URL(badUrl).host), `host_permissions must NOT cover ${fakeTld}`);
    }
  }
});
