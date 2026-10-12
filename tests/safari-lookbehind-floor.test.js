// Drift guard (issue #98): the declared compatibility floor is Safari 14.0
// on macOS 11.5 (README "Requirements" + the Xcode target's
// MACOSX_DEPLOYMENT_TARGET = 11.5 in both Debug and Release), but WebKit
// only shipped RegExp lookbehind assertions in Safari 16.4. Any lookbehind
// source — the positive, negative, and named spellings (the detector
// below spells them in escaped form, issue #104) — in any SHIPPED
// extension module is therefore a SyntaxError at regex-construction
// time on every Safari in the declared band — and in the #98 instance the
// throw sat inside redactTermFromUrl, whose first call in the redirect path
// is the appendDebugLog 'targetUrl' argument (background.js), so the
// navigation was swallowed and the redirect silently never happened.
//
// CI cannot catch this: the node --test suite runs on Node 22 and the
// headless-Chrome e2e on a modern engine — both support lookbehind. So this
// guard does what the repo's text-parsing drift guards do (blocked-schemes
// #18, engine-presets #25, manifest #9): it reads the shipped modules as
// text and fails the build if a lookbehind source ever lands in them again.
//
// Scope is deliberately the SHIPPED extension surface only — the files that
// actually run inside Safari. The node --test suite itself (Node 22+) and
// the release tooling (scripts/*.mjs, run on CI runners) may use modern
// syntax freely; e.g. tests/i18n-consistency.test.js contains a lookbehind
// in a test-only regex and is correctly out of scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'QueryHop Extension/Resources');

// The shipped extension modules: every JS file the service worker or the
// popup evaluates inside Safari. Derived from the directory, not pinned —
// a newly added module must be floor-clean without touching this test.
const shippedModules = fs.readdirSync(extDir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.js'))
  .map((e) => e.name);

// The Safari host-window script is also shipped (it runs in the host
// window, same WebKit floor).
const hostScript = path.join(root, 'QueryHop/Resources/Script.js');

// (#104) The three lookbehind spellings, as a single escaped literal.
// The escaped form is deliberate on two counts: an unescaped raw source
// in this file would defeat the guard if the test were ever added to the
// scanned set, and one literal is the single place all three forms are
// defined. The alternatives:
//   (?<=        — positive lookbehind (the form #98 caught),
//   (?<!        — negative lookbehind (Safari 16.4 too — missed by #98),
//   (?<name=    — NAMED lookbehind (also 16.4 — missed by #98; the #98
//                 comment claimed the substring check caught it, but the
//                 character after (?< is a name letter, not =).
// The named alternative requires the = delimiter: a plain named CAPTURE
// (?<name>x shares the (?<name prefix but is legal on the floor, so it
// must not be flagged. A lookAHEAD (?= never matches — the third
// character is =, not <.
const LOOKBEHIND_SOURCE = /\(\?<=|\(\?<!|\(\?<[a-zA-Z][a-zA-Z0-9_]*=/;

// Scan raw source text line-by-line for lookbehind regex sources. Exported
// so the detector itself is unit-testable against synthetic lines (#104)
// — the drift guards in this repo are only as strong as their detectors.
export function findLookbehindLines(source) {
  const hits = [];
  source.split('\n').forEach((line, i) => {
    if (LOOKBEHIND_SOURCE.test(line)) hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

function findLookbehinds(file) {
  return findLookbehindLines(fs.readFileSync(file, 'utf8'));
}

test('bgCommon.js is free of lookbehind regex sources (#98)', () => {
  const bgCommon = path.join(extDir, 'bgCommon.js');
  assert.ok(fs.existsSync(bgCommon), 'bgCommon.js is missing');
  const hits = findLookbehinds(bgCommon);
  assert.deepEqual(
    hits,
    [],
    `bgCommon.js contains a lookbehind regex source (positive / negative / ` +
      `named spelling — Safari <16.4, the declared floor is 14.0, throws ` +
      `SyntaxError at construction; the #98 instance of that killed the ` +
      `redirect path):\n` +
      hits.map((h) => `  line ${h.line}: ${h.text}`).join('\n')
  );
});

test('every shipped extension module stays within the Safari 14.0 JS floor: no lookbehinds (#98)', () => {
  const targets = [
    ...shippedModules.map((n) => path.join(extDir, n)),
    hostScript,
  ];
  for (const file of targets) {
    assert.ok(fs.existsSync(file), `shipped module is missing: ${path.relative(root, file)}`);
    const hits = findLookbehinds(file);
    assert.deepEqual(
      hits,
      [],
      `${path.relative(root, file)} contains a lookbehind regex source (positive / ` +
        `negative / named spelling) — the module ships to Safari 14.0+ ` +
        `where lookbehinds (Safari 16.4+) throw at regex construction:\n` +
        hits.map((h) => `  line ${h.line}: ${h.text}`).join('\n')
    );
  }
});

// (#104) Detector unit tests: the original detector was a single literal
// substring check for the positive spelling only, so the negative
// spelling and the named spelling (which the #98 comment claimed was
// "caught as a substring" but was not) slipped through green. These drive
// the detector against synthetic shipped-module lines — the same text the
// guard would read off a shipped .js file — for every spelling.

test('#104: a synthetic line with the negative lookbehind source is flagged', () => {
  const hits = findLookbehindLines(
    "const re = new RegExp('(?<!foo)bar');"
  );
  assert.equal(hits.length, 1, 'the negative lookbehind is the same WebKit 16.4 feature — equally fatal');
});

test('#104: a synthetic line with the named lookbehind source is flagged', () => {
  const hits = findLookbehindLines(
    'const re = /(?<name=\\d+)-/;'
  );
  assert.equal(hits.length, 1, 'the named spelling (?<name= was missed by the substring-only detector');
});

test('#104: a plain named CAPTURE is NOT flagged (no false positive)', () => {
  // Named captures (?<name>x are legal on the Safari 14.0 floor — they
  // share the (?<name prefix with the named lookbehind, so the detector
  // must require the = delimiter to tell them apart.
  const hits = findLookbehindLines(
    'const re = /(?<name>\\d+)-/;'
  );
  assert.deepEqual(hits, [], 'named capture is not a lookbehind');
});

test('#104: a line with only a lookahead is NOT flagged', () => {
  // LookAHEAD (?= is legal on the floor — guard the no-false-positive
  // property the original comment promised.
  const hits = findLookbehindLines(
    'const re = /(?=\\d)/;'
  );
  assert.deepEqual(hits, [], 'a lookahead is not a lookbehind');
});
