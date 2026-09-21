// Invariant tests for the popup i18n wiring — issue #21.
//
// The extension's UI text lives in three places that must stay in sync:
//   1. the locale files (QueryHop Extension/Resources/_locales/{en,de}/messages.json)
//   2. popup.html — static markup, localized via data-i18n* attributes
//   3. popup.js   — dynamic strings (validation status, save/copy feedback,
//      debug-log states), localized via t('key', englishFallback)
//
// Nothing enforces the invariants at runtime: chrome.i18n falls back to the
// English literal in popup.js (or the hardcoded HTML) when a key is missing,
// so a new UI string added without a locale key — or a locale key that
// silently lost its German translation — degrades to English with no error.
// This test fails the build on that drift, same pattern as
// blocked-schemes-consistency.test.js (#18) and manifest-consistency.test.js
// (#9).
//
// popup.html and popup.js are parsed as text (popup.js touches the DOM at
// module scope, so importing it under Node is impossible); the pure modules
// popupRules.js / popupState.js are imported directly for their pinned
// strings, exactly as their own test suites do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEBUG_LOG_EMPTY_TEXT } from '../QueryHop Extension/Resources/popupRules.js';
import {
  SAVE_FEEDBACK_STATES,
  COPY_FEEDBACK_STATES,
  DEFAULT_PRESET_BUTTON_TEXT,
} from '../QueryHop Extension/Resources/popupState.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourceDir = path.join(root, 'QueryHop Extension/Resources');
const localesDir = path.join(resourceDir, '_locales');

for (const p of [
  path.join(resourceDir, 'popup.html'),
  path.join(resourceDir, 'popup.js'),
  path.join(localesDir, 'en', 'messages.json'),
  path.join(localesDir, 'de', 'messages.json'),
]) {
  assert.ok(fs.existsSync(p), `${p} is missing`);
}

const popupHtml = fs.readFileSync(path.join(resourceDir, 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(resourceDir, 'popup.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));
const de = JSON.parse(fs.readFileSync(path.join(localesDir, 'de', 'messages.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Locale file structure
// ---------------------------------------------------------------------------

const messageKeys = (locale) => Object.keys(locale);

test('every locale message has a non-empty "message" and a "description"', () => {
  for (const [name, locale] of [
    ['en', en],
    ['de', de],
  ]) {
    for (const [key, entry] of Object.entries(locale)) {
      assert.equal(typeof entry.message, 'string', `${name}: ${key} has no "message"`);
      assert.ok(entry.message.trim(), `${name}: ${key} has an empty message`);
      assert.equal(typeof entry.description, 'string', `${name}: ${key} has no "description"`);
      assert.ok(entry.description.trim(), `${name}: ${key} has an empty description`);
    }
  }
});

test('en and de declare exactly the same key set', () => {
  const onlyEn = messageKeys(en).filter((k) => !de[k]);
  const onlyDe = messageKeys(de).filter((k) => !en[k]);
  assert.deepEqual(onlyEn, [], `keys in en but NOT in de: ${onlyEn.join(', ')}`);
  assert.deepEqual(onlyDe, [], `keys in de but NOT in en: ${onlyDe.join(', ')}`);
});

// The URL-placeholder token "%s" is literal user-facing text in these
// messages (the token the user must put in their custom URL). Both locales
// must keep it, or the German UI would tell users a placeholder that does
// not exist.
test('the URL-placeholder token survives in both locales', () => {
  for (const key of ['validation_missing_placeholder', 'custom_url_hint', 'custom_url_placeholder']) {
    for (const [name, locale] of [
      ['en', en],
      ['de', de],
    ]) {
      assert.ok(
        locale[key]?.message?.includes('%s'),
        `${name}: ${key} lost the literal "%s" URL-placeholder token`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// HTML markup <-> en locale sync
// ---------------------------------------------------------------------------

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');

// For every <tag ... data-i18n*="key"> in popup.html, return
// { key, which ('' | '-html' | '-title' | '-placeholder'), tag, inner }
// where `inner` is the element's raw inner content (markup included for the
// -html variants) and `tag` is the full opening tag.
function markedElements(html) {
  const attrRe = /data-i18n(?:-html|-title|-placeholder)?="([a-z_0-9]+)"/g;
  const out = [];
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    const tagStart = html.lastIndexOf('<', m.index);
    const tagName = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(tagStart))[1];
    const innerGt = html.indexOf('>', m.index);
    const tag = html.slice(tagStart, innerGt + 1);
    const which = m[0].startsWith('data-i18n-html')
      ? '-html'
      : m[0].startsWith('data-i18n-placeholder')
        ? '-placeholder'
        : m[0].startsWith('data-i18n-title')
          ? '-title'
          : '';
    // Void elements (input, br, meta, ...) and XML-style self-closing tags
    // have no closing tag and no inner content.
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    if (VOID.has(tagName) || tag.endsWith('/>')) {
      out.push({ key: m[1], which, tag, inner: '' });
      continue;
    }
    // Walk forward counting nested same-name tags to find this element's
    // close.
    let depth = 1;
    let pos = innerGt + 1;
    const closeRe = new RegExp(`<(/?)${tagName}(\\s[^>]*)?/?>`, 'gi');
    closeRe.lastIndex = pos;
    let cm;
    while (depth > 0 && (cm = closeRe.exec(html)) !== null) {
      if (cm[1] === '/') depth -= 1;
      else if (!cm[0].endsWith('/>')) depth += 1;
      pos = cm.index + cm[0].length;
    }
    assert.ok(depth === 0, `unbalanced <${tagName}> for data-i18n key "${m[1]}"`);
    const span = html.slice(innerGt + 1, pos);
    const closeTag = `</${tagName}>`;
    const inner =
      which === '-html' || which === ''
        ? span.slice(0, span.lastIndexOf(closeTag))
        : span;
    out.push({ key: m[1], which, tag, inner });
  }
  return out;
}

const elements = markedElements(popupHtml);

test('popup.html marks at least one i18n element (extraction did not silently break)', () => {
  assert.ok(elements.length >= 20, `expected ~24 marked elements, parsed ${elements.length}`);
});

test('every data-i18n* key in popup.html exists in both locales', () => {
  for (const el of elements) {
    assert.ok(en[el.key], `popup.html key "${el.key}" is missing from _locales/en`);
    assert.ok(de[el.key], `popup.html key "${el.key}" is missing from _locales/de`);
  }
});

test('popup.html English literals match the en locale (the literals are the fallback)', () => {
  for (const el of elements) {
    const msg = en[el.key]?.message;
    assert.ok(msg !== undefined, `en locale is missing "${el.key}"`);
    if (el.which === '') {
      // Text element: strip markup, decode entities, normalize whitespace.
      const literal = norm(decodeEntities(el.inner.replace(/<[^>]+>/g, ' ')));
      assert.equal(
        literal,
        norm(msg),
        `popup.html literal for "${el.key}" drifted from the en locale:\n` +
          `  html : ${literal}\n  en   : ${norm(msg)}`
      );
    } else if (el.which === '-html') {
      // InnerHTML element: the raw markup IS the message (whitespace-normalized).
      assert.equal(
        norm(el.inner),
        norm(msg),
        `popup.html innerHTML for "${el.key}" drifted from the en locale:\n` +
          `  html : ${norm(el.inner)}\n  en   : ${norm(msg)}`
      );
    } else if (el.which === '-placeholder') {
      const literal = /placeholder="([^"]*)"/.exec(el.tag)?.[1];
      assert.equal(
        literal,
        msg,
        `popup.html placeholder for "${el.key}" drifted from the en locale:\n` +
          `  html : ${literal}\n  en   : ${msg}`
      );
    } else if (el.which === '-title') {
      const literal = /title="([^"]*)"/.exec(el.tag)?.[1];
      assert.equal(
        literal,
        msg,
        `popup.html title for "${el.key}" drifted from the en locale:\n` +
          `  html : ${literal}\n  en   : ${msg}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// popup.js <-> en locale sync
// ---------------------------------------------------------------------------

// t('key', ...) call sites. The lookbehind keeps this from matching
// createElement('...') or updatePresetButtonText('...') — those are
// identifiers, and the call is preceded by `(` or whitespace only here.
const jsKeys = [...popupJs.matchAll(/(?<![A-Za-z0-9_$])t\('([a-z_0-9]+)'/g)].map((m) => m[1]);

test('popup.js t() call sites exist (extraction did not silently break)', () => {
  assert.ok(new Set(jsKeys).size >= 15, `expected ~21 distinct t() keys, parsed ${new Set(jsKeys).size}`);
});

test('every t() key in popup.js exists in both locales', () => {
  for (const key of new Set(jsKeys)) {
    assert.ok(en[key], `popup.js key "${key}" is missing from _locales/en`);
    assert.ok(de[key], `popup.js key "${key}" is missing from _locales/de`);
  }
});

// t('key', 'English literal') — the fallback must equal the en locale,
// otherwise a runtime without the key would render the wrong English text.
const literalFallbacks = [
  ...popupJs.matchAll(/(?<![A-Za-z0-9_$])t\('([a-z_0-9]+)',\s*'([^']*)'\)/g),
].map((m) => [m[1], m[2]]);

test('t() literal fallbacks match the en locale', () => {
  assert.ok(literalFallbacks.length >= 3, `expected >=3 literal-fallback t() calls, parsed ${literalFallbacks.length}`);
  for (const [key, literal] of literalFallbacks) {
    assert.equal(
      en[key]?.message,
      literal,
      `fallback for "${key}" in popup.js drifted from the en locale:\n` +
        `  js   : ${literal}\n  en   : ${en[key]?.message}`
    );
  }
});

// ---------------------------------------------------------------------------
// popupRules.js messages <-> popup.js validation switch
// ---------------------------------------------------------------------------

// The English validation strings are pinned in popupRules.js (unit-tested
// there, asserted field-by-field in popup-rules.test.js); popup.js maps each
// to its i18n key in a switch. Drift in either direction breaks the German
// UI silently: a new message without a case renders English in every locale;
// a stale case or a key whose en message changed maps nothing.
const popupRules = fs.readFileSync(path.join(resourceDir, 'popupRules.js'), 'utf8');
const emittedMessages = [...popupRules.matchAll(/message:\s*(['"])((?:[^'\\]|\\.)*?)\1/g)].map((m) =>
  m[2].replace(/\\'/g, "'").replace(/\\"/g, '"')
);

test('popupRules.js still emits validation messages (extraction did not silently break)', () => {
  assert.ok(emittedMessages.length >= 7, `expected >=7 validation messages, parsed ${emittedMessages.length}`);
});

test('every popupRules.js validation message has a case in popup.js (no untranslated strings)', () => {
  const cases = new Set(
    [...popupJs.matchAll(/case\s+'([^']+)':/g)].map((m) => m[1])
  );
  const uncovered = emittedMessages.filter((msg) => !cases.has(msg));
  assert.deepEqual(
    uncovered,
    [],
    `validation messages in popupRules.js with no case in popup.js:\n  ${uncovered.join('\n  ')}`
  );
});

test('each validation case in popup.js maps to a locale key whose en message matches the literal', () => {
  const cases = [...popupJs.matchAll(/case\s+'([^']+)':\s*\n\s*return t\('([a-z_0-9]+)'/g)];
  assert.ok(cases.length >= 7, `expected >=7 validation cases, parsed ${cases.length}`);
  for (const [, literal, key] of cases) {
    assert.ok(en[key], `validation case key "${key}" is missing from _locales/en`);
    assert.equal(
      en[key].message,
      literal,
      `en locale for validation key "${key}" drifted from the popupRules.js message:\n` +
        `  rules: ${literal}\n  en   : ${en[key].message}`
    );
  }
});

// ---------------------------------------------------------------------------
// Pinned state labels (popupState.js) <-> en locale
// ---------------------------------------------------------------------------

test('save-button feedback labels match the en locale', () => {
  const map = {
    [SAVE_FEEDBACK_STATES.default.label]: 'save_options',
    [SAVE_FEEDBACK_STATES.saving.label]: 'save_saving',
    [SAVE_FEEDBACK_STATES.success.label]: 'save_success',
    [SAVE_FEEDBACK_STATES.successDisabled.label]: 'save_success_disabled',
    [SAVE_FEEDBACK_STATES.error.label]: 'save_error',
  };
  for (const [label, key] of Object.entries(map)) {
    assert.equal(
      en[key]?.message,
      label,
      `en locale "${key}" drifted from popupState.js: ${label}`
    );
    assert.ok(de[key], `de locale is missing "${key}"`);
  }
});

test('copy-log feedback labels match the en locale', () => {
  const map = {
    [COPY_FEEDBACK_STATES.idle]: 'copy_log',
    [COPY_FEEDBACK_STATES.copied]: 'copy_copied',
    [COPY_FEEDBACK_STATES.failed]: 'copy_failed',
    [COPY_FEEDBACK_STATES.nothing]: 'copy_nothing',
  };
  for (const [label, key] of Object.entries(map)) {
    assert.equal(
      en[key]?.message,
      label,
      `en locale "${key}" drifted from popupState.js: ${label}`
    );
    assert.ok(de[key], `de locale is missing "${key}"`);
  }
});

test('the default preset button text matches the en locale', () => {
  assert.equal(
    en.select_preset?.message,
    DEFAULT_PRESET_BUTTON_TEXT,
    `en locale select_preset drifted from popupState.js: ${DEFAULT_PRESET_BUTTON_TEXT}`
  );
  assert.ok(de.select_preset, 'de locale is missing select_preset');
});

test('the empty-debug-log text matches the en locale', () => {
  assert.equal(
    en.debug_log_empty?.message,
    DEBUG_LOG_EMPTY_TEXT,
    `en locale debug_log_empty drifted from popupRules.js: ${DEBUG_LOG_EMPTY_TEXT}`
  );
  assert.ok(de.debug_log_empty, 'de locale is missing debug_log_empty');
});

// ---------------------------------------------------------------------------
// Orphan keys: every locale key must be used somewhere (or be a manifest key)
// ---------------------------------------------------------------------------

test('no orphan keys: every en locale key is used in HTML, JS, or the manifest', () => {
  const used = new Set([
    // manifest.json's __MSG_* references
    'extension_name',
    'extension_description',
    ...elements.map((el) => el.key),
    ...jsKeys,
  ]);
  const orphans = messageKeys(en).filter((k) => !used.has(k));
  assert.deepEqual(orphans, [], `unused locale keys (dead translations): ${orphans.join(', ')}`);
});
