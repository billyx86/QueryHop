// i18n helpers for the options popup (issue #21).
//
// chrome.i18n.getMessage is the only runtime API, but this module never
// touches chrome.* — it takes the message source as a parameter so the
// fallback logic is unit-testable under plain `node --test` (same pattern as
// popupRules.js / popupState.js). popup.js wires it up with the real
// chrome.i18n and keeps the English literal as fallback, so a missing key
// (or a runtime without chrome.i18n) degrades to English instead of blanking
// the UI.
//
// Placeholder convention:
//   - messages.json may use the standard WebKit/Chrome named placeholders
//     ($name$ via a "placeholders" map; $$ for a literal $). When a key is
//     found, chrome.i18n.getMessage performs that substitution itself.
//   - A bare "%s" in a message is NOT a placeholder in either engine — in
//     QueryHop it is the user-facing URL-placeholder token (the literal
//     text users must include in their custom URL) and renders as-is.
//   - The English fallback literals mirror the message text; if a fallback
//     ever needs a runtime value, pass it to t() and applySubstitutions()
//     fills %s tokens left-to-right. No current message mixes a literal
//     "%s" with a runtime substitution, so the two uses never collide.

import { SAVE_FEEDBACK_STATES } from './popupState.js';

// Replace %s tokens left-to-right, one substitution per token. With no
// substitutions the template is returned untouched (so a literal "%s" — the
// URL-placeholder token — survives). Extra substitutions beyond the token
// count are ignored.
export function applySubstitutions(template, substitutions) {
  const subs = Array.isArray(substitutions) ? substitutions : [];
  let text = template == null ? '' : String(template);
  for (const sub of subs) {
    text = text.replace('%s', String(sub));
  }
  return text;
}

// Build a t(key, fallback, ...substitutions) function.
// `getMessage` may be any function (the real chrome.i18n.getMessage or a
// stub). Substitutions are passed through to getMessage (Chrome's %1..%9
// format). If the key is missing, returns '', or getMessage is absent/throws,
// the English fallback is used and substituted with the %s convention.
export function makeT(getMessage) {
  return function t(key, fallback, ...substitutions) {
    let text = '';
    try {
      if (typeof getMessage === 'function') {
        text = getMessage(key, substitutions.length ? substitutions : undefined) || '';
      }
    } catch {
      text = '';
    }
    if (!text) text = applySubstitutions(fallback, substitutions);
    return text;
  };
}

// popupState.js keeps the English save-button labels (unit-tested there);
// this factory maps each state to its i18n key so the popup renders the
// label in the UI language. Built from a t() (see makeT) so it is pure of
// DOM and chrome.* — popup.js builds it once per boot. Unknown states fall
// through to the default "Save Options" label.
export function makeLocalizedSaveLabel(t) {
  return function localizedSaveLabel(state) {
    if (state === SAVE_FEEDBACK_STATES.saving) return t('save_saving', state.label);
    if (state === SAVE_FEEDBACK_STATES.success) return t('save_success', state.label);
    if (state === SAVE_FEEDBACK_STATES.successDisabled) return t('save_success_disabled', state.label);
    if (state === SAVE_FEEDBACK_STATES.error) return t('save_error', state.label);
    return t('save_options', state.label);
  };
}

// popupRules.js pins the English validation strings (unit-tested there);
// this factory maps each to its i18n key at the display boundary. Unknown
// strings pass through untouched. Like makeLocalizedSaveLabel it is built
// from a t() so it stays pure of DOM and chrome.*.
export function makeLocalizedValidationMessage(t) {
  return function localizedValidationMessage(message) {
    switch (message) {
      case 'Leaving the URL empty will disable redirection':
        return t('validation_info_empty', message);
      case 'URL must include %s in place of your query':
        return t('validation_missing_placeholder', message);
      case 'URL must start with http(s)://':
        return t('validation_bad_prefix', message);
      case 'URL format valid':
        return t('validation_valid', message);
      case 'Invalid URL format':
        return t('validation_invalid', message);
      case 'URL scheme is not allowed, even in unsafe mode':
        return t('validation_blocked_scheme', message);
      case 'URL validation is disabled':
        return t('validation_bypassed', message);
      default:
        return message;
    }
  };
}

// Sync <html lang> to the browser UI language (base language only — the
// lang attribute takes "de", not "de-DE") so screen readers and
// language-sensitive heuristics classify the popup correctly (issue #46).
// popup.html declares lang="en" statically, but the strings are resolved at
// runtime through chrome.i18n, which follows the browser's UI language.
// The host window solves the same problem the other way around: its
// Main.html declares the locale and Script.js reads it back. Pure of any
// runtime API: `language` is the navigator.language to use ('en' when the
// runtime has none) and `documentElement` exposes a settable .lang.
export function syncDocumentLanguage(language, documentElement) {
  const base = (language || 'en').split('-')[0];
  documentElement.lang = base;
  return base;
}

// Apply data-i18n attributes to a document. The fallback for each element is
// its own current English content/attribute, so running this on markup that
// already carries the English literals always renders something:
//   [data-i18n]              -> textContent
//   [data-i18n-html]         -> innerHTML (value carries the markup, e.g. <code>)
//   [data-i18n-placeholder]  -> placeholder attribute
//   [data-i18n-title]        -> title attribute
// Works on any document-like object with querySelectorAll — Node tests pass a
// small fake. Elements without the attributes are left alone.
export function applyI18n(t, doc) {
  doc.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    el.textContent = t(key, (el.textContent || '').trim());
  });
  doc.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    if (!key) return;
    el.innerHTML = t(key, el.innerHTML);
  });
  doc.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (!key) return;
    el.setAttribute('placeholder', t(key, el.getAttribute('placeholder') || ''));
  });
  doc.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (!key) return;
    el.setAttribute('title', t(key, el.getAttribute('title') || ''));
  });
}
