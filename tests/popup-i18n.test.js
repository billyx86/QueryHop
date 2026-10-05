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
  makeLocalizedSaveLabel,
  makeLocalizedValidationMessage,
  syncDocumentLanguage,
} from '../QueryHop Extension/Resources/popupI18n.js';

import {
  SAVE_FEEDBACK_STATES,
} from '../QueryHop Extension/Resources/popupState.js';

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

// ---------------------------------------------------------------------------
// makeLocalizedSaveLabel (issue #64: save-button label at the i18n boundary)
// ---------------------------------------------------------------------------

test('makeLocalizedSaveLabel: maps each SAVE_FEEDBACK_STATES state to its i18n key', () => {
  const seen = [];
  const t = (key, _fallback) => {
    seen.push(key);
    return `L10N(${key})`;
  };
  const label = makeLocalizedSaveLabel(t);
  // State key -> i18n key. Note the underscore: successDisabled -> save_success_disabled.
  const expectedKey = {
    default: 'save_options',
    saving: 'save_saving',
    success: 'save_success',
    successDisabled: 'save_success_disabled',
    error: 'save_error',
  };
  for (const [name, state] of Object.entries(SAVE_FEEDBACK_STATES)) {
    assert.equal(label(state), `L10N(${expectedKey[name]})`);
  }
  assert.deepEqual(seen, [
    'save_options',
    'save_saving',
    'save_success',
    'save_success_disabled',
    'save_error',
  ]);
});

test('makeLocalizedSaveLabel: falls back to the English label when the key is missing', () => {
  // A real t() is built by makeT and itself falls back to the English literal
  // when getMessage finds no key — simulate that with a t() that always misses.
  const t = makeT(() => '');
  const label = makeLocalizedSaveLabel(t);
  assert.equal(label(SAVE_FEEDBACK_STATES.saving), 'Saving...');
  assert.equal(label(SAVE_FEEDBACK_STATES.default), 'Save Options');
  assert.equal(label(SAVE_FEEDBACK_STATES.successDisabled), 'Saved! (Disabled)');
});

test('makeLocalizedSaveLabel: passes the English label as the t() fallback', () => {
  const seen = [];
  const t = (key, fallback) => {
    seen.push([key, fallback]);
    return 'found';
  };
  makeLocalizedSaveLabel(t)(SAVE_FEEDBACK_STATES.error);
  assert.deepEqual(seen, [['save_error', 'Error!']]);
});

// ---------------------------------------------------------------------------
// makeLocalizedValidationMessage (issue #64: status-line copy at the i18n boundary)
// ---------------------------------------------------------------------------

test('makeLocalizedValidationMessage: maps the seven pinned English strings to keys', () => {
  const t = (key, _fallback) => `L10N(${key})`;
  const localize = makeLocalizedValidationMessage(t);
  assert.equal(localize('Leaving the URL empty will disable redirection'), 'L10N(validation_info_empty)');
  assert.equal(localize('URL must include %s in place of your query'), 'L10N(validation_missing_placeholder)');
  assert.equal(localize('URL must start with http(s)://'), 'L10N(validation_bad_prefix)');
  assert.equal(localize('URL format valid'), 'L10N(validation_valid)');
  assert.equal(localize('Invalid URL format'), 'L10N(validation_invalid)');
  assert.equal(localize('URL scheme is not allowed, even in unsafe mode'), 'L10N(validation_blocked_scheme)');
  assert.equal(localize('URL validation is disabled'), 'L10N(validation_bypassed)');
});

test('makeLocalizedValidationMessage: unknown strings pass through untouched', () => {
  const localize = makeLocalizedValidationMessage(() => '');
  assert.equal(localize('something else'), 'something else');
  assert.equal(localize(''), '');
});

test('makeLocalizedValidationMessage: falls back to the English string when the key is missing', () => {
  const localize = makeLocalizedValidationMessage(makeT(() => ''));
  assert.equal(localize('URL format valid'), 'URL format valid');
  assert.equal(localize('URL must include %s in place of your query'), 'URL must include %s in place of your query');
});

// ---------------------------------------------------------------------------
// syncDocumentLanguage (issue #46 a11y: <html lang> follows the UI language)
// ---------------------------------------------------------------------------

test('syncDocumentLanguage: writes the base language (no region) to <html lang>', () => {
  const el = {};
  assert.equal(syncDocumentLanguage('de-DE', el), 'de');
  assert.equal(el.lang, 'de');
  assert.equal(syncDocumentLanguage('en-US', el), 'en');
  assert.equal(el.lang, 'en');
});

test('syncDocumentLanguage: falls back to "en" for an empty language', () => {
  const el = {};
  assert.equal(syncDocumentLanguage('', el), 'en');
  assert.equal(el.lang, 'en');
  assert.equal(syncDocumentLanguage(undefined, el), 'en');
});
