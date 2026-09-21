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
    } catch (e) {
      text = '';
    }
    if (!text) text = applySubstitutions(fallback, substitutions);
    return text;
  };
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
