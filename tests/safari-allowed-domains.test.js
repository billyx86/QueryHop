// Drift guard (issue #76): the Safari Web-Extension bundle manifest
// (QueryHop Extension/Info.plist) declares a SFSafariWebsiteAccess "Allowed
// Domains" list. Safari matches only the listed registrable domains (and
// their subdomains), so any engine host missing from that list is silently
// never redirected on Safari, even though the identical URL redirects on
// Chrome (whose manifest.json host_permissions IS guarded, #2/#27).
//
// It used to hard-code 7 base domains (google.com, duckduckgo.com, bing.com,
// ecosia.org, baidu.com, yahoo.com, yandex.com) — missing 11 of the 12 Google
// TLDs and 4 of the 5 Yandex TLDs, so e.g. a search on google.de or yandex.ru
// never redirected on Safari. This guard re-derives the canonical host(s) of
// every search engine straight from the REAL searchEngines regexes in
// bgCommon.js (no hand-maintained domain list) and fails if the plist stops
// covering any of them — the same "single implementation, no hard-coded list"
// philosophy as tests/engine-permissions-sync.test.js.
//
// bgCommon.js carries no top-level chrome references (it is a pure
// data/helpers module), so it can be imported directly under node --test.
// The Info.plist is parsed as XML text (no plist dependency, no chrome mock),
// so the whole file runs with plain `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plistPath = path.join(root, 'QueryHop Extension/Info.plist');
const bgCommonPath = path.join(root, 'QueryHop Extension/Resources/bgCommon.js');

assert.ok(fs.existsSync(plistPath), 'Info.plist is missing');
assert.ok(fs.existsSync(bgCommonPath), 'bgCommon.js is missing');

// The real engine regexes — the single source of truth (issue #25).
const { searchEngines } = await import(bgCommonPath);

// Referenced by code point so this file carries no hand-typed escape
// sequences (same convention as engine-permissions-sync.test.js).
const BS = String.fromCharCode(92);

// Derive the canonical registrable host(s) an engine pattern is meant to
// redirect, straight from the regex source (no hand-maintained list). The
// pattern body still contains its escape sequences, so unescape them first
// (an escaped dot becomes a plain dot, ...). Then two shapes are recognized:
//   optional-subdomain prefix + base + "(tld|tld|...)"  -> one host per TLD
//   a plain literal hostname                             -> that hostname
function deriveEngineHosts(patternSource) {
  let src = '';
  for (let i = 0; i < patternSource.length; i++) {
    if (patternSource[i] === BS && i + 1 < patternSource.length) {
      src += patternSource[i + 1];
      i++;
    } else {
      src += patternSource[i];
    }
  }
  const start = src.indexOf('://') + 3;
  const end = src.indexOf('/', start);
  let expr = src.slice(start, end === -1 ? undefined : end);
  // Strip the optional-subdomain prefix (plain string, no regex needed).
  const optSub = '(?:w+.)?';
  if (expr.startsWith(optSub)) expr = expr.slice(optSub.length);
  // base.(tld|tld|...) -> one canonical host per alternative
  const group = expr.match(new RegExp('^([a-z]+)' + BS + '.' + BS + '(' + '([^()]+)' + BS + ')'));
  if (group) {
    return group[2].split('|').map((tld) => group[1] + '.' + tld);
  }
  if (/^[a-z0-9][a-z0-9.-]*$/.test(expr)) {
    return [expr];
  }
  throw new Error('cannot derive a canonical host from pattern: ' + patternSource);
}

// Parse the SFSafariWebsiteAccess -> "Allowed Domains" <string> entries out of
// the plist. Scoped to that array so an unrelated <string> elsewhere can't
// pollute the result.
function parseAllowedDomains(plist) {
  const m = plist.match(/<key>Allowed Domains<\/key>\s*<array>([\s\S]*?)<\/array>/);
  assert.ok(m, 'Info.plist is missing the SFSafariWebsiteAccess "Allowed Domains" array');
  return [...m[1].matchAll(/<string>([^<]+)<\/string>/g)].map((s) => s[1].trim());
}

const plist = fs.readFileSync(plistPath, 'utf8');
const allowedDomains = parseAllowedDomains(plist);

// Safari matches a listed registrable domain AND its subdomains, so a derived
// host is covered iff it equals a listed domain or is a subdomain of one
// (e.g. the plist lists "yahoo.com", which covers the Yahoo engine's literal
// host "search.yahoo.com"). Listing only the base domain would NOT cover a
// different TLD — "google.com" does not cover "google.de".
function hostCovered(host) {
  return allowedDomains.some((d) => host === d || host.endsWith('.' + d));
}

test('Info.plist Allowed Domains covers every canonical engine host (derived, no hard-coded list) (#76)', () => {
  assert.ok(searchEngines.length >= 5, 'expected several searchEngines, found ' + searchEngines.length);
  const missing = [];
  for (const engine of searchEngines) {
    for (const host of deriveEngineHosts(engine.pattern.source)) {
      if (!hostCovered(host)) missing.push(`${engine.name}:${host}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `Info.plist "Allowed Domains" missing: ${missing.join(', ')}. ` +
      'Safari would silently never redirect those engine hosts, even though ' +
      'host_permissions in manifest.json covers them (see #2/#27).'
  );
});

test('Info.plist Allowed Domains keeps Level "Some" (per-domain access, not All) (#76)', () => {
  // "All" would grant the extension access to every site the user visits —
  // far beyond the search engines this redirect covers. The allowlist must
  // stay the explicit, reviewable "Some" form.
  const m = plist.match(/<key>Level<\/key>\s*<string>([^<]+)<\/string>/);
  assert.ok(m, 'Info.plist is missing the SFSafariWebsiteAccess "Level" key');
  assert.equal(
    m[1].trim(),
    'Some',
    `SFSafariWebsiteAccess Level is "${m[1].trim()}" — it must stay "Some" so only the listed domains are reachable`
  );
});

test('Info.plist still declares the Safari web-extension point (#76)', () => {
  // Guard against the plist being pointed at the wrong extension point, which
  // would detach it from the Safari web extension regardless of the domains.
  assert.match(
    plist,
    /<key>NSExtensionPointIdentifier<\/key>\s*<string>com\.apple\.Safari\.web-extension<\/string>/,
    'Info.plist NSExtensionPointIdentifier must be com.apple.Safari.web-extension'
  );
});
