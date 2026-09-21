// Unit tests for the i18n helpers in
// QueryHop Extension/Resources/popupI18n.js (issue #21).
//
// popupI18n.js is deliberately free of DOM and chrome.* access — it takes the
// message source and the document as parameters — so this suite imports the
// module directly and passes stubs, same as popup-rules.test.js /
// popup-state.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySubstitutions,
  makeT,
  applyI18n,
} from '../QueryHop Extension/Resources/popupI18n.js';

// ---------------------------------------------------------------------------
// applySubstitutions
// ---------------------------------------------------------------------------

test('applySubstitutions: no substitutions leaves the template untouched (literal %s survives)', () => {
  // The URL-placeholder token "%s" is literal text in QueryHop's messages —
  // it must render as-is when nothing is substituted.
  assert.equal(
    applySubstitutions('URL must include %s in place of your query'),
    'URL must include %s in place of your query'
  );
  assert.equal(applySubstitutions('plain text', []), 'plain text');
});

test('applySubstitutions: fills %s tokens left-to-right', () => {
  assert.equal(applySubstitutions('a %s b %s c', ['X', 'Y']), 'a X b Y c');
});

test('applySubstitutions: extra substitutions beyond the token count are ignored', () => {
  assert.equal(applySubstitutions('one %s', ['X', 'Y', 'Z']), 'one X');
});

test('applySubstitutions: non-array substitutions are treated as none', () => {
  assert.equal(applySubstitutions('a %s b', undefined), 'a %s b');
  assert.equal(applySubstitutions('a %s b', null), 'a %s b');
});

test('applySubstitutions: coerces non-string substitutions and tolerates a null template', () => {
  assert.equal(applySubstitutions('count %s', [42]), 'count 42');
  assert.equal(applySubstitutions(null, ['X']), '');
});

// ---------------------------------------------------------------------------
// makeT
// ---------------------------------------------------------------------------

test('makeT: returns the localized message when the key is found', () => {
  const getMessage = (key) => (key === 'hello' ? 'Hallo' : '');
  const t = makeT(getMessage);
  assert.equal(t('hello', 'Hello'), 'Hallo');
});

test('makeT: falls back to the English literal when the key is missing', () => {
  const t = makeT(() => '');
  assert.equal(t('missing', 'Save Options'), 'Save Options');
});

test('makeT: falls back when getMessage is absent (runtime without chrome.i18n)', () => {
  const t = makeT(null);
  assert.equal(t('missing', 'Save Options'), 'Save Options');
});

test('makeT: falls back when getMessage throws', () => {
  const t = makeT(() => {
    throw new Error('boom');
  });
  assert.equal(t('missing', 'Save Options'), 'Save Options');
});

test('makeT: applies %s substitutions to the fallback when the key is missing', () => {
  const t = makeT(() => '');
  assert.equal(t('missing', 'Redirected %s to %s', 'google.com', 'kagi.com'), 'Redirected google.com to kagi.com');
});

test('makeT: passes substitutions through to getMessage', () => {
  const calls = [];
  const t = makeT((key, subs) => {
    calls.push([key, subs]);
    return 'found';
  });
  assert.equal(t('k', 'fallback', 'A', 'B'), 'found');
  assert.deepEqual(calls, [['k', ['A', 'B']]]);
});

test('makeT: does not pass an empty substitutions array to getMessage', () => {
  const calls = [];
  const t = makeT((key, subs) => {
    calls.push([key, subs]);
    return 'found';
  });
  assert.equal(t('k', 'fallback'), 'found');
  assert.deepEqual(calls, [['k', undefined]]);
});

// ---------------------------------------------------------------------------
// applyI18n
// ---------------------------------------------------------------------------

function makeEl({ textContent = '', innerHTML = '', attrs = {} } = {}) {
  return {
    textContent,
    innerHTML,
    attrs,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  };
}

function makeDoc(elements) {
  return {
    querySelectorAll(selector) {
      const m = selector.match(/^\[([\w-]+)\]$/);
      assert.ok(m, `unexpected selector: ${selector}`);
      return elements.filter((el) => el.getAttribute(m[1]) !== null);
    },
  };
}

test('applyI18n: localizes [data-i18n] textContent', () => {
  const el = makeEl({ textContent: 'Save Options', attrs: { 'data-i18n': 'save_options' } });
  applyI18n(() => 'OPTIONEN SPEICHERN', makeDoc([el]));
  assert.equal(el.textContent, 'OPTIONEN SPEICHERN');
});

test('applyI18n: localizes [data-i18n-html] innerHTML (markup preserved)', () => {
  const el = makeEl({
    innerHTML: 'Start with <code>http(s)://</code>',
    attrs: { 'data-i18n-html': 'custom_url_hint' },
  });
  applyI18n(() => 'Mit <code>http(s)://</code> beginnen', makeDoc([el]));
  assert.equal(el.innerHTML, 'Mit <code>http(s)://</code> beginnen');
});

test('applyI18n: localizes [data-i18n-placeholder] placeholder attribute', () => {
  const el = makeEl({ attrs: { placeholder: 'e.g. https://x.com/?q=%s', 'data-i18n-placeholder': 'custom_url_placeholder' } });
  applyI18n(() => 'z. B. https://x.com/?q=%s', makeDoc([el]));
  assert.equal(el.getAttribute('placeholder'), 'z. B. https://x.com/?q=%s');
});

test('applyI18n: localizes [data-i18n-title] title attribute', () => {
  const el = makeEl({ attrs: { title: 'Copy the log', 'data-i18n-title': 'copy_log_title' } });
  applyI18n(() => 'Protokoll kopieren', makeDoc([el]));
  assert.equal(el.getAttribute('title'), 'Protokoll kopieren');
});

test('applyI18n: leaves elements without i18n attributes alone', () => {
  const el = makeEl({ textContent: 'Ask.com', attrs: { class: 'preset-name' } });
  applyI18n(() => 'SHOULD NOT RUN', makeDoc([el]));
  assert.equal(el.textContent, 'Ask.com');
});

test('applyI18n: empty attribute value is ignored, other elements still processed', () => {
  const blank = makeEl({ textContent: 'keep', attrs: { 'data-i18n': '' } });
  const real = makeEl({ textContent: 'Save Options', attrs: { 'data-i18n': 'save_options' } });
  applyI18n((key) => (key === 'save_options' ? 'Gespeichert' : 'WRONG'), makeDoc([blank, real]));
  assert.equal(blank.textContent, 'keep');
  assert.equal(real.textContent, 'Gespeichert');
});
