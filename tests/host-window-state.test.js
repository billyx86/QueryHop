// Behavioral tests for the Safari host-window state machinery in
// QueryHop/Resources/Script.js (issue #85).
//
// Script.js is a classic (non-module) script that reaches the native side
// through the webkit.messageHandlers bridge. Its DOM/chrome surface is small
// (document.getElementsByClassName / querySelector / getElementById,
// document.body.classList, and the open-preferences click), so the same
// pattern as tests/popup-harness.js works: stand up a minimal fake `document`
// + `webkit` on globalThis, import a fresh copy of the REAL Script.js
// (cache-busted ?run= query), and drive the real functions through
// globalThis.QueryHopHost (issue #85's test surface). No browser, no npm deps.
//
// The fake document mirrors the text-bearing DOM shape of
// QueryHop/Resources/Base.lproj/Main.html (the three state <p>, the
// open-preferences <button>, an empty body) so what is exercised here is the
// same element set the shipped window actually has.
//
// The MESSAGES table, key set and <html lang> markers are guarded separately
// by tests/host-window-i18n.test.js (en/de key parity, real-German content,
// a11y attributes). This file covers what the code *does* with that table and
// deliberately derives its expected strings from the real MESSAGES table
// (host.MESSAGES) — it never re-hardcodes copy, so the i18n test stays the
// single source of truth for wording and this one only pins behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const scriptUrl = new URL('../QueryHop/Resources/Script.js', import.meta.url).href;

// ---------------------------------------------------------------------------
// Minimal fake host window (mirrors Base.lproj/Main.html)
// ---------------------------------------------------------------------------
function buildFakeWindow({ lang = 'en', omitElements = [] } = {}) {
  const omit = new Set(omitElements);

  const makeEl = (tag = 'div') => {
    const el = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      innerText: '',
      _attrs: {},
      _listeners: {},
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
      },
      setAttribute(name, value) { this._attrs[name] = String(value); },
      removeAttribute(name) { delete this._attrs[name]; },
      addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
      click() { for (const fn of this._listeners['click'] ?? []) fn({ type: 'click' }); },
    };
    const classes = new Set();
    el.classList = {
      add: (...n) => { for (const x of n) classes.add(x); },
      remove: (...n) => { for (const x of n) classes.delete(x); },
      toggle(name, force) {
        const want = typeof force === 'boolean' ? force : !classes.has(name);
        if (want) classes.add(name); else classes.delete(name);
        return classes.has(name);
      },
      contains: (n) => classes.has(n),
    };
    return el;
  };

  // Text-bearing elements from Main.html, in document order.
  const byClass = {};
  const stateUnknown = omit.has('state-unknown') ? null : makeEl('p');
  const stateOn = omit.has('state-on') ? null : makeEl('p');
  const stateOff = omit.has('state-off') ? null : makeEl('p');
  const button = omit.has('open-preferences') ? null : makeEl('button');
  if (stateUnknown) byClass['state-unknown'] = stateUnknown;
  if (stateOn) byClass['state-on'] = stateOn;
  if (stateOff) byClass['state-off'] = stateOff;
  if (button) byClass['open-preferences'] = button; // Main.html: <button class="open-preferences">

  const idRegistry = {};
  const indexById = (node) => { if (node && node.id) idRegistry[node.id] = node; };

  const body = makeEl('body');
  body._children = [];
  body.insertBefore = function (node, ref) {
    indexById(node);
    const i = ref ? this._children.indexOf(ref) : -1;
    if (i >= 0) this._children.splice(i, 0, node); else this._children.push(node);
    return node;
  };
  Object.defineProperty(body, 'firstChild', { get() { return this._children[0] ?? null; } });

  const document = {
    documentElement: { lang },
    body,
    getElementsByClassName(className) {
      return byClass[className] ? [byClass[className]] : [];
    },
    // The only selector Script.js uses.
    querySelector(selector) {
      if (selector === 'button.open-preferences') return button;
      return null;
    },
    // Faithful-enough getElementById: consults the id registry, populated as
    // elements are inserted — so a runtime-created #native-error is found on
    // the second showError() call, exactly as in a real document.
    getElementById(id) { return idRegistry[id] ?? null; },
    createElement(tag) { return makeEl(tag); },
  };

  const postedMessages = [];
  const webkit = {
    messageHandlers: {
      controller: { postMessage: (msg) => postedMessages.push(msg) },
    },
  };

  return {
    document,
    webkit,
    postedMessages,
    els: { stateUnknown, stateOn, stateOff, button, body },
  };
}

// Import a fresh copy of the REAL Script.js against a fake host window and
// hand back its globalThis.QueryHopHost test surface plus the fake parts.
let runId = 0;
async function bootHostWindow(opts = {}) {
  const win = buildFakeWindow(opts);
  globalThis.document = win.document;
  globalThis.webkit = win.webkit;
  await import(`${scriptUrl}?run=${++runId}`);
  const host = globalThis.QueryHopHost;
  assert.ok(host, 'Script.js did not expose globalThis.QueryHopHost');
  return { host, ...win };
}

// ---------------------------------------------------------------------------
// detectLocale() — <html lang> -> MESSAGES table, English fallback
// ---------------------------------------------------------------------------
test('detectLocale: German lang (de) resolves to the de table', async () => {
  const { host } = await bootHostWindow({ lang: 'de' });
  assert.equal(host.detectLocale(), 'de');
});

test('detectLocale: a regional tag (de-DE) uses its base language', async () => {
  const { host } = await bootHostWindow({ lang: 'de-DE' });
  assert.equal(host.detectLocale(), 'de');
});

test('detectLocale: a shipped-but-unsupported locale (fr) falls back to en', async () => {
  const { host } = await bootHostWindow({ lang: 'fr' });
  assert.equal(host.detectLocale(), 'en');
});

test('detectLocale: a regional tag of an unsupported locale (fr-FR) falls back to en', async () => {
  const { host } = await bootHostWindow({ lang: 'fr-FR' });
  assert.equal(host.detectLocale(), 'en');
});

test('detectLocale: empty lang resolves to the en fallback', async () => {
  const { host } = await bootHostWindow({ lang: '' });
  assert.equal(host.detectLocale(), 'en');
});

test('detectLocale: an english regional tag (en-US) resolves to en', async () => {
  const { host } = await bootHostWindow({ lang: 'en-US' });
  assert.equal(host.detectLocale(), 'en');
});

test('detectLocale: an uppercase lang is normalized before lookup', async () => {
  const { host } = await bootHostWindow({ lang: 'DE' });
  assert.equal(host.detectLocale(), 'de');
});

// ---------------------------------------------------------------------------
// t(key) — locale-resolved key lookup with English fallback
// ---------------------------------------------------------------------------
test('t: resolves a key against the active (German) locale', async () => {
  const { host } = await bootHostWindow({ lang: 'de' });
  // Must return the de wording, which the i18n test pins as non-English.
  assert.equal(host.t('state_on'), host.MESSAGES.de.state_on);
  assert.notEqual(host.t('state_on'), host.MESSAGES.en.state_on);
});

test('t: resolves a key against the en locale', async () => {
  const { host } = await bootHostWindow({ lang: 'en' });
  assert.equal(host.t('state_on'), host.MESSAGES.en.state_on);
});

test('t: an unknown key falls back to English, and is undefined if en lacks it too', async () => {
  const { host } = await bootHostWindow({ lang: 'de' });
  assert.equal(host.t('no_such_key_anywhere'), undefined);
  // A real key still resolves even under the de locale.
  assert.equal(host.t('state_on'), host.MESSAGES.de.state_on);
});

// ---------------------------------------------------------------------------
// setText() — class-scoped update, no-op (not throw) when the element is gone
// ---------------------------------------------------------------------------
test('setText: updates the first element matching the class', async () => {
  const { host, els } = await bootHostWindow();
  assert.equal(host.setText('state-on', 'hello'), true);
  assert.equal(els.stateOn.innerText, 'hello');
});

test('setText: returns false and no-ops when the class has no element', async () => {
  const { host } = await bootHostWindow();
  assert.equal(host.setText('does-not-exist', 'x'), false);
});

// ---------------------------------------------------------------------------
// populateStateText() — MESSAGES is the single source of truth for the copy
// ---------------------------------------------------------------------------
test('populateStateText: every state element + button text comes from MESSAGES', async () => {
  const { host, els } = await bootHostWindow();
  host.populateStateText();
  assert.equal(els.stateOn.innerText, host.MESSAGES.en.state_on);
  assert.equal(els.stateOff.innerText, host.MESSAGES.en.state_off);
  assert.equal(els.stateUnknown.innerText, host.MESSAGES.en.state_unknown);
  assert.equal(els.button.innerText, host.MESSAGES.en.open_preferences);
});

test('populateStateText: sets a localized aria-label mirroring the button text', async () => {
  const { host, els } = await bootHostWindow({ lang: 'de' });
  host.populateStateText();
  assert.equal(els.button.getAttribute('aria-label'), host.MESSAGES.de.open_preferences);
  assert.equal(els.button.innerText, host.MESSAGES.de.open_preferences);
});

// ---------------------------------------------------------------------------
// show(enabled, useSettingsInsteadOfPreferences) — label/state switching
// ---------------------------------------------------------------------------
test('show(true): body shows state-on, not state-off', async () => {
  const { host, els } = await bootHostWindow();
  host.show(true);
  assert.equal(els.body.classList.contains('state-on'), true);
  assert.equal(els.body.classList.contains('state-off'), false);
});

test('show(false): body shows state-off, not state-on', async () => {
  const { host, els } = await bootHostWindow();
  host.show(false);
  assert.equal(els.body.classList.contains('state-off'), true);
  assert.equal(els.body.classList.contains('state-on'), false);
});

test('show(undefined): a non-boolean hides both definitive states', async () => {
  const { host, els } = await bootHostWindow();
  host.show(true);
  host.show(undefined);
  assert.equal(els.body.classList.contains('state-on'), false);
  assert.equal(els.body.classList.contains('state-off'), false);
});

test('show(): re-populates the state copy each call (#29)', async () => {
  const { host, els } = await bootHostWindow();
  els.stateOn.innerText = 'stale';
  host.show(true);
  assert.equal(els.stateOn.innerText, host.MESSAGES.en.state_on);
});

test('show(): the settings-vs-preferences arg is accepted for native-caller compat', async () => {
  const { host } = await bootHostWindow();
  // Retained in the signature for the native caller; must not throw.
  assert.doesNotThrow(() => host.show(true, true));
  assert.doesNotThrow(() => host.show(false, false));
});

// ---------------------------------------------------------------------------
// showError(message) — native Settings-open failure, shown inline
// ---------------------------------------------------------------------------
test('showError(message): localized prefix (from MESSAGES) + system description', async () => {
  const { host, els } = await bootHostWindow();
  host.showError('The operation could not be completed.');
  const el = els.body._children.find((c) => c.id === 'native-error');
  assert.ok(el, 'a #native-error element was created');
  assert.equal(el.innerText, `${host.MESSAGES.en.native_error_prefix} The operation could not be completed.`);
});

test('showError: a falsy message falls back to the localized fallback line', async () => {
  const { host, els } = await bootHostWindow({ lang: 'de' });
  host.showError();
  let el = els.body._children.find((c) => c.id === 'native-error');
  assert.equal(el.innerText, host.MESSAGES.de.native_error_fallback);
  host.showError('');
  el = els.body._children.find((c) => c.id === 'native-error');
  assert.equal(el.innerText, host.MESSAGES.de.native_error_fallback);
});

test('showError: the element carries id/class/role and is created once', async () => {
  const { host, els } = await bootHostWindow();
  host.showError('boom');
  host.showError('again');
  const created = els.body._children.filter((c) => c.id === 'native-error');
  assert.equal(created.length, 1, 'a second showError must reuse the element, not duplicate it');
  const el = created[0];
  assert.equal(el.getAttribute('role'), 'status');
  assert.match(el.className, /native-error/);
  assert.doesNotMatch(el.className, /state-unknown/);
});

test('showError: the created element is a <p> inserted at the top of body', async () => {
  const { host, els } = await bootHostWindow();
  host.showError('x');
  const el = els.body._children[0];
  assert.equal(el.id, 'native-error');
  assert.equal(el.tagName, 'P');
});

// ---------------------------------------------------------------------------
// openPreferences() + button wiring — the webkit message bridge
// ---------------------------------------------------------------------------
test('openPreferences(): posts "open-preferences" to the native controller', async () => {
  const { host, postedMessages } = await bootHostWindow();
  host.openPreferences();
  assert.deepEqual(postedMessages, ['open-preferences']);
});

test('clicking the open-preferences button posts "open-preferences"', async () => {
  const { els, postedMessages } = await bootHostWindow();
  els.button.click();
  assert.deepEqual(postedMessages, ['open-preferences']);
});

// ---------------------------------------------------------------------------
// The shipped-surface invariants the refactor must not break
// ---------------------------------------------------------------------------
test('Script.js still exposes the full state surface on globalThis.QueryHopHost', async () => {
  const { host } = await bootHostWindow();
  for (const name of ['MESSAGES', 'setText', 'detectLocale', 't', 'populateStateText', 'show', 'showError', 'openPreferences']) {
    assert.ok(name in host, `QueryHopHost missing surface member: ${name}`);
  }
});

test('Script.js pre-populates the state copy at load time (#29)', async () => {
  // On import, populateStateText() already ran once — the window is not empty
  // even when the native side never calls show() (state-fetch failure).
  const { host, els } = await bootHostWindow();
  assert.equal(els.stateOn.innerText, host.MESSAGES.en.state_on);
  assert.equal(els.stateOff.innerText, host.MESSAGES.en.state_off);
});

test('the German locale end-to-end: show(true) renders the German state copy', async () => {
  const { host, els } = await bootHostWindow({ lang: 'de' });
  host.show(true);
  assert.equal(els.stateOn.innerText, host.MESSAGES.de.state_on);
  assert.notEqual(els.stateOn.innerText, host.MESSAGES.en.state_on);
});

test('a missing state element degrades without throwing', async () => {
  const { host } = await bootHostWindow({ omitElements: ['state-on'] });
  assert.doesNotThrow(() => host.show(true));
  assert.doesNotThrow(() => host.populateStateText());
});
