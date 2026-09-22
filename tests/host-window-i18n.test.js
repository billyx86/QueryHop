// Drift guard (issue #26): the host app window (Main.html) ships an English
// copy under Base.lproj and a German copy under de.lproj. The dynamic strings
// (state lines, the open-preferences button, the native error prefix) live in
// the MESSAGES table of Script.js, which is picked per locale via
// <html lang>. This test enforces parity across the three pieces:
//
//   1. MESSAGES tables: en and de define the exact same key set (a new key in
//      one locale without the other fails), and en stays the fallback.
//   2. Main.html locale files: identical DOM shape (same text-bearing
//      elements, in the same order) and the right <html lang> marker.
//   3. The de copy is actually German — the English static strings are not
//      left un-translated in de.lproj (brand names and the GitHub URL aside).
//
// Script.js is parsed as TEXT (not imported): its module-level code touches
// document/webkit, which do not exist under node --test. Same pattern as the
// other consistency tests in this directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseHtmlPath = path.join(root, 'QueryHop/Resources/Base.lproj/Main.html');
const deHtmlPath = path.join(root, 'QueryHop/Resources/de.lproj/Main.html');
const scriptPath = path.join(root, 'QueryHop/Resources/Script.js');
const viewControllerPath = path.join(root, 'QueryHop/ViewController.swift');

for (const p of [baseHtmlPath, deHtmlPath, scriptPath, viewControllerPath]) {
  assert.ok(fs.existsSync(p), `${p} is missing`);
}

const baseHtml = fs.readFileSync(baseHtmlPath, 'utf8');
const deHtml = fs.readFileSync(deHtmlPath, 'utf8');
const script = fs.readFileSync(scriptPath, 'utf8');
const viewController = fs.readFileSync(viewControllerPath, 'utf8');

// --- 1. the MESSAGES table in Script.js ---
// The table is written strict-JSON-compatible on purpose so it can be parsed
// as text without executing the file.
const messagesBlock = script.match(/var MESSAGES = (\{[\s\S]*?\n\});/);
assert.ok(messagesBlock, 'MESSAGES table not found in Script.js');
const MESSAGES = JSON.parse(messagesBlock[1]);

const requiredKeys = [
  'state_on',
  'state_off',
  'state_unknown',
  'open_preferences',
  'native_error_prefix',
  'native_error_fallback',
];

test('Script.js MESSAGES defines en and de tables', () => {
  assert.ok(MESSAGES.en, 'en table missing from MESSAGES');
  assert.ok(MESSAGES.de, 'de table missing from MESSAGES');
});

test('en and de MESSAGES tables define the exact same key set (#26)', () => {
  const enKeys = Object.keys(MESSAGES.en).sort();
  const deKeys = Object.keys(MESSAGES.de).sort();
  assert.deepEqual(deKeys, enKeys, `de keys drifted from en.\n  en: ${JSON.stringify(enKeys)}\n  de: ${JSON.stringify(deKeys)}`);
});

test('MESSAGES still defines every key Script.js resolves (#26)', () => {
  // Script.js must keep referencing keys that exist — a renamed key would
  // silently fall back to the English literal and defeat the whole locale.
  for (const key of requiredKeys) {
    assert.ok(MESSAGES.en[key], `MESSAGES.en missing required key: ${key}`);
    assert.match(script, new RegExp(`t\\('${key}'\\)`), `Script.js no longer resolves t('${key}')`);
  }
});

test('every localized value is non-empty in both locales (#26)', () => {
  for (const locale of ['en', 'de']) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      assert.ok(typeof value === 'string' && value.trim().length > 0, `MESSAGES.${locale}.${key} is empty`);
    }
  }
});

test('Script.js falls back to English for unknown locales (#26)', () => {
  // detectLocale must keep "en" as the fallback (same pattern as the popup's
  // t(key, englishFallback)) so a missing locale degrades to English instead
  // of undefined strings.
  assert.match(script, /function detectLocale\(\)[\s\S]*?return MESSAGES\[base\] \? base : "en";/);
});

test('ViewController.swift no longer hard-codes the English error prefix (#26)', () => {
  // Only the system error description may be interpolated into showError();
  // the "Could not open Safari Settings:" prefix comes from MESSAGES.
  assert.ok(
    !viewController.includes('Could not open Safari Settings: \\('),
    'ViewController.swift still builds the English error sentence natively'
  );
  assert.match(viewController, /showError\('\\\(message\)'\)/, 'ViewController.swift no longer calls showError()');
});

// --- 2. Main.html locale files: same DOM shape, correct lang marker ---
function decodeEntities(s) {
  return s
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&uuml;/g, 'ü')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, ' ');
}

function extractTextElements(html) {
  // The text-bearing elements, in document order: the three state <p>
  // elements, the open-preferences <button>, and the developed-by <p>.
  const out = [];
  const re = /<(p|button)\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html))) {
    const text = decodeEntities(m[3].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    out.push({ tag: m[1], cls: m[2], text });
  }
  return out;
}

test('Base.lproj and de.lproj Main.html exist with the right <html lang> (#26)', () => {
  assert.match(baseHtml, /<html lang="en">/, 'Base.lproj/Main.html must declare lang="en" (fallback locale)');
  assert.match(deHtml, /<html lang="de">/, 'de.lproj/Main.html must declare lang="de"');
});

test('both Main.html locale files have identical text-element shape (#26)', () => {
  const enEls = extractTextElements(baseHtml);
  const deEls = extractTextElements(deHtml);
  assert.equal(deEls.length, enEls.length, `de.lproj has ${deEls.length} text elements, en has ${enEls.length}`);
  assert.deepEqual(
    deEls.map((e) => [e.tag, e.cls]),
    enEls.map((e) => [e.tag, e.cls]),
    'text-bearing elements (tag+class, in order) drifted between en and de'
  );
});

// The English static strings that must NOT survive un-translated in the de
// copy. Brand name (QueryHop), the author line's name, and the GitHub URL
// are expected to appear in both.
const UNTRANSLATED_ENGLISH = [
  'You can turn on QueryHop',
  'is currently enabled',
  'is currently off',
  'Quit and Open',
  'Developed by',
  'Fully open source',
];

test('de.lproj Main.html does not keep the English static strings (#26)', () => {
  const missing = UNTRANSLATED_ENGLISH.filter((s) => deHtml.includes(s));
  assert.deepEqual(missing, [], `un-translated English strings left in de.lproj/Main.html: ${missing.join(' | ')}`);
});

test('de.lproj Main.html actually carries German copy (#26)', () => {
  // A de file that is an English copy (or an empty stub) would pass the
  // shape check above; require real German content.
  assert.ok(/Sie k\u00f6nnen|aktivieren|Beenden/.test(deHtml), 'de.lproj/Main.html does not contain the expected German copy');
  const deEls = extractTextElements(deHtml);
  const nonEmpty = deEls.filter((e) => e.text.length > 0);
  assert.ok(nonEmpty.length >= 4, `expected at least 4 non-empty text elements in de.lproj, found ${nonEmpty.length}`);
});

test('both locale files keep the GitHub repo link and author (#26)', () => {
  for (const [name, html] of [['en', baseHtml], ['de', deHtml]]) {
    assert.match(html, /https:\/\/github\.com\/billyx86\/QueryHop/, `${name}: GitHub link missing`);
    assert.match(html, /billyx86/, `${name}: author handle missing`);
  }
});

// --- 3. dynamic strings stay in sync with the static copy ---
test('the native error prefix still names Safari Settings in both locales (#26)', () => {
  assert.match(MESSAGES.en.native_error_prefix, /Safari Settings/, 'en prefix drifted');
  assert.match(MESSAGES.de.native_error_prefix, /Safari-Einstellungen/, 'de prefix drifted');
});
