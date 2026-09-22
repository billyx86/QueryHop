// Invariant test (issue #27): host_permissions in manifest.json must cover
// every search engine declared in background.js.
//
// The old CI sanity check kept a hand-maintained list of six engine domains
// and missed the seventh (Yandex) — exactly the drift this guard exists to
// prevent. This test derives the canonical host(s) of each engine straight
// from its searchEngines pattern (no hand-maintained engine list) and fails
// if host_permissions stops covering any of them. It also runs in the CI
// validate job, so the guard works even before the full suite.
//
// Both files are parsed as text (no module import, no chrome mock), so this
// runs with plain node --test. The hostMatcher below is copied verbatim from
// tests/manifest-consistency.test.js to keep the matcher semantics in one
// place; a backslash character appears in this file only as a verbatim copy
// or via String.fromCharCode(92), never as a hand-typed escape sequence.

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

// host_permissions matcher: "base.com" matches the base domain itself OR any
// subdomain (copied verbatim from tests/manifest-consistency.test.js).
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
function hostCovered(host) {
  return matchers.some((r) => r.test(host));
}

// Referenced by code point so this file carries no hand-typed escape sequences.
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

// Derive the canonical hostnames an engine pattern is meant to redirect,
// straight from the pattern text (no hand-maintained engine list). The pattern
// body captured between the regex-literal delimiters still contains its escape
// sequences, so unescape them first (an escaped slash becomes a plain slash,
// an escaped dot a plain dot, ...). Then two shapes are recognized:
//   optional-subdomain prefix + base + "(tld|tld|...)"  -> one host per TLD
//   a plain literal hostname                             -> that hostname
function deriveEngineHosts(patternSource) {
  let src = "";
  for (let i = 0; i < patternSource.length; i++) {
    if (patternSource[i] === BS && i + 1 < patternSource.length) {
      src += patternSource[i + 1];
      i++;
    } else {
      src += patternSource[i];
    }
  }
  // "https?://" ends in two slashes; the host starts right after them.
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

// Parse the searchEngines entries (pattern body + name) from background.js.
const engineBlock = background.match(/const searchEngines = \[([\s\S]*?)\];/);
assert.ok(engineBlock, 'could not find the searchEngines array in background.js');
const engines = [];
for (const rawLine of engineBlock[1].split(NL)) {
  const line = rawLine.trim();
  const openMarker = 'pattern: /';
  if (!line.includes(openMarker)) continue;
  const openIdx = line.indexOf(openMarker) + openMarker.length;
  // The pattern body ends at the first unescaped "/, " (slash+comma+space);
  // interior slashes are always escape sequences, so this is unambiguous.
  const closeIdx = line.indexOf('/, ', openIdx);
  if (closeIdx === -1) continue;
  const source = line.slice(openIdx, closeIdx);
  const nameMatch = line.match(/name: "([^"]*)"/);
  if (!nameMatch) continue;
  engines.push({ name: nameMatch[1], source });
}

test('background.js declares 7 search engines with derivable canonical hosts', () => {
  assert.equal(engines.length, 7, 'expected 7 searchEngines entries, found ' + engines.length);
  for (const engine of engines) {
    const hosts = deriveEngineHosts(engine.source); // throws on an unrecognized pattern shape
    assert.ok(hosts.length >= 1, engine.name + ': no canonical hosts derived from its pattern');
  }
});

test('host_permissions covers every canonical engine host (derived, no hard-coded list)', () => {
  // If a future change drops an engine's hosts from host_permissions (or
  // widens an engine pattern past its permissions), this fails — the exact
  // gap the hard-coded 6-engine list used to leave for Yandex (issue #27).
  const missing = [];
  for (const engine of engines) {
    for (const host of deriveEngineHosts(engine.source)) {
      if (!hostCovered(host)) missing.push(engine.name + ":" + host);
    }
  }
  assert.deepEqual(missing, [], 'host_permissions missing: ' + missing.join(', '));
});

test('the manifest still declares a non-empty host_permissions list', () => {
  assert.ok(hostPermissions.length >= 5, 'expected several host_permissions');
});
