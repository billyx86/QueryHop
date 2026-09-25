// Shared fake-DOM + fake-chrome harness for driving the REAL popup.js under
// node --test (issue #38).
//
// popup.js registers everything behind a single DOMContentLoaded listener,
// so bootPopup():
//   1. installs a fake `document`, `chrome` and `navigator` on globalThis,
//   2. imports a fresh instance of popup.js (cache-busted ?run= query),
//   3. fires DOMContentLoaded and waits for the initial restoreOptions() /
//      loadDebugLog() promise chains to settle.
//
// Tests then drive the real handlers by dispatching synthetic events on the
// fake elements (click, keydown, input, change) and assert on the resulting
// DOM state, the fake chrome.storage data and the runtime messages the
// popup sent (LOG_MESSAGE, UPDATE_RULES, ...).
//
// Timers — the 1200ms feedback reset, the 300ms input debounce, the 50ms
// preset-focus delay — are captured in a manual queue, so tests advance time
// with state.tick(ms) instead of waiting in real time (and no real timer
// handles keep the test process alive).

class FakeElement {
  constructor(ownerDoc, id, opts = {}) {
    this.ownerDoc = ownerDoc;
    this.id = id ?? null;
    this.tagName = String(opts.tag || 'div').toUpperCase();
    this._attrs = { ...(opts.attrs || {}) };
    this.style = { ...(opts.style || {}) };
    this._classes = new Set(opts.classes || []);
    this.textContent = opts.text ?? '';
    this.innerHTML = this.textContent;
    this.value = opts.value ?? '';
    this.checked = !!opts.checked;
    this.disabled = false;
    this.dataset = { ...(opts.dataset || {}) };
    this.children = [];
    this.parentNode = null;
    this._listeners = {};
    this.selectCalls = 0;
    ownerDoc.__registry.push(this);
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get classList() {
    const classes = this._classes;
    return {
      add: (...names) => { for (const n of names) classes.add(n); },
      remove: (...names) => { for (const n of names) classes.delete(n); },
      contains: (name) => classes.has(name),
    };
  }

  get offsetHeight() { return 0; }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }

  setAttribute(name, value) {
    this._attrs[name] = String(value);
  }

  removeAttribute(name) {
    delete this._attrs[name];
  }

  addEventListener(type, fn) {
    (this._listeners[type] ??= []).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  appendChild(child) {
    if (child.parentNode) {
      const sibs = child.parentNode.children;
      const i = sibs.indexOf(child);
      if (i !== -1) sibs.splice(i, 1);
    }
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  get nextElementSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.children;
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }

  get previousElementSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.children;
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] : null;
  }

  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }

  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child);
      out.push(...child.descendants());
    }
    return out;
  }

  querySelectorAll(selector) {
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const attr = selector.slice(1, -1);
      return this.descendants().filter((el) => el.getAttribute(attr) !== null);
    }
    const cls = selector.replace(/^\./, '');
    return this.descendants().filter((el) => el._classes.has(cls));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    const cls = selector.replace(/^\./, '');
    let node = this;
    while (node && node._classes) {
      if (node._classes.has(cls)) return node;
      node = node.parentNode;
    }
    return null;
  }

  focus() {
    if (this.ownerDoc) this.ownerDoc.activeElement = this;
  }

  blur() {
    if (this.ownerDoc && this.ownerDoc.activeElement === this) {
      this.ownerDoc.activeElement = null;
    }
  }

  select() {
    this.selectCalls += 1;
  }

  // DOM-style dispatch: target first, then ancestors up to the fake document
  // (stopPropagation() halts the walk).
  dispatchEvent(type, props = {}) {
    const event = {
      type,
      target: this,
      key: props.key,
      ctrlKey: !!props.ctrlKey,
      metaKey: !!props.metaKey,
      defaultPrevented: false,
      _stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this._stopped = true; },
    };
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    for (const node of path) {
      const handlers = node._listeners ? node._listeners[type] : null;
      if (handlers) for (const fn of handlers) fn(event);
      if (event._stopped) break;
    }
    return event;
  }

  click() {
    return this.dispatchEvent('click');
  }
}

// Two presets by default (Kagi / Brave, matching popup.html); tests may pass
// options.presets to override.
const DEFAULT_PRESETS = [
  ['https://kagi.com/search?q=%s', 'Kagi'],
  ['https://search.brave.com/search?q=%s', 'Brave'],
];

let runId = 0;

// Boot a fresh instance of the real popup.js against a fake browser
// environment. `options`:
//   storage            — initial chrome.storage.local contents
//   storageGetError    — string: lastError message for storage.local.get
//   storageSetError    — string: lastError message for storage.local.set
//   storageSetThrow    — boolean: storage.local.set throws synchronously
//   updateRulesResponse— 'ack' (default) | 'no-receiver' | explicit response
//                        object (e.g. { success: false })
//   debugLogResponse   — GET_DEBUG_LOG response, 'error' for lastError,
//                        or omit for the default empty success
//   clearLogResponse   — CLEAR_DEBUG_LOG response (default success)
//   i18nMessages       — { key: message } map faking chrome.i18n; omit for
//                        "no i18n" (English fallbacks)
//   presets            — [[url, name], ...] for the dropdown items
//   omitElements       — element ids that are missing from the DOM (init
//                        failure path)
//   clipboard          — 'ok' | 'reject' | custom writeText fn; omit for
//                        "clipboard API unavailable"
//   execCommandResult  — boolean returned by document.execCommand (default
//                        true)
//   asyncChrome        — boolean: defer chrome callbacks one tick so the
//                        in-flight 'Saving...' state is observable
export async function bootPopup(options = {}) {
  const state = {
    options,
    sentMessages: [],
    storage: { ...(options.storage || {}) },
    execCommandCalls: [],
    clipboardWriteCalls: [],
    debugLogQueue: [],
  };
  // Queue an additional GET_DEBUG_LOG response consumed by the next
  // loadDebugLog()/copyDebugLog() (e.g. a refresh after a log entry lands).
  state.queueDebugLogResponse = (r) => state.debugLogQueue.push(r);

  // --- Fake timers -------------------------------------------------------
  const pending = new Map();
  let timerSeq = 0;
  let parkSeq = 0;
  let nowMs = 0;
  globalThis.setTimeout = (fn, delay = 0) => {
    const id = ++timerSeq;
    pending.set(id, { fn, dueAt: nowMs + Math.max(0, Number(delay) || 0) });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    pending.delete(id);
  };
  state.tick = (ms = 0) => {
    const target = nowMs + ms;
    for (;;) {
      let nextId = null;
      let nextDue = Infinity;
      for (const [id, timer] of pending) {
        if (timer.dueAt <= target && timer.dueAt < nextDue) {
          nextDue = timer.dueAt;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = pending.get(nextId);
      pending.delete(nextId);
      nowMs = timer.dueAt;
      timer.fn();
    }
    nowMs = target;
  };
  state.hasPendingTimers = () => pending.size > 0;
  // Park a deferred chrome callback with a strictly increasing due time, so
  // each flushNext() runs exactly one parked callback — tests can step
  // through an async save (storage.set → UPDATE_RULES) and observe the
  // in-flight 'Saving...' state between the two.
  const park = (fn) => {
    const id = ++timerSeq;
    pending.set(id, { fn, dueAt: nowMs + ++parkSeq, parked: true });
    return id;
  };
  // Run exactly one parked callback (the earliest due). Returns false when
  // nothing is parked. Real timers (feedback resets, debounce) are left
  // alone — advance those with tick().
  state.flushNext = () => {
    let nextId = null;
    let nextDue = Infinity;
    for (const [id, timer] of pending) {
      if (timer.parked && timer.dueAt < nextDue) {
        nextDue = timer.dueAt;
        nextId = id;
      }
    }
    if (nextId === null) return false;
    const timer = pending.get(nextId);
    pending.delete(nextId);
    nowMs = timer.dueAt;
    timer.fn();
    return true;
  };
  // Run parked callbacks until none remain (each may park more).
  state.drainParked = () => {
    for (; state.flushNext(); ) { /* drain */ }
  };

  // --- Fake DOM ----------------------------------------------------------
  const byId = new Map();
  const document = {
    _listeners: {},
    activeElement: null,
    __registry: [],
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    },
    getElementById(id) {
      return byId.get(id) ?? null;
    },
    createElement(tag) {
      return new FakeElement(document, null, { tag });
    },
    execCommand(command) {
      state.execCommandCalls.push(command);
      if (options.execCommandThrow) throw new Error('execCommand exploded');
      return options.execCommandResult ?? true;
    },
    querySelectorAll(selector) {
      if (selector.startsWith('[') && selector.endsWith(']')) {
        const attr = selector.slice(1, -1);
        return document.__registry.filter((el) => el.getAttribute(attr) !== null);
      }
      const cls = selector.replace(/^\./, '');
      return document.__registry.filter((el) => el._classes.has(cls));
    },
    querySelector(selector) {
      return document.querySelectorAll(selector)[0] ?? null;
    },
  };
  document.body = new FakeElement(document, 'body', { tag: 'body' });
  document.body.parentNode = document;

  const makeElement = (id, opts) => {
    const el = new FakeElement(document, id, opts);
    document.body.appendChild(el);
    byId.set(id, el);
    return el;
  };

  // Element set mirrors popup.html (see Resources/popup.html).
  const omit = new Set(options.omitElements || []);
  if (!omit.has('save')) {
    makeElement('save', { tag: 'button', attrs: { 'data-i18n': 'save_options' }, text: 'Save Options' });
  }
  if (!omit.has('searchUrl')) {
    makeElement('searchUrl', {
      tag: 'input',
      attrs: { placeholder: 'e.g. https://duckduckgo.com/?q=%s', 'data-i18n-placeholder': 'custom_url_placeholder' },
    });
  }
  if (!omit.has('urlHint')) {
    makeElement('urlHint', { tag: 'p', classes: ['description'], attrs: { 'data-i18n-html': 'custom_url_hint' }, text: 'Hint' });
  }
  if (!omit.has('unsafeMode')) makeElement('unsafeMode', { tag: 'input' });
  if (!omit.has('unsafeWarning')) makeElement('unsafeWarning', { tag: 'div', style: { display: 'none' } });
  if (!omit.has('enableExtension')) makeElement('enableExtension', { tag: 'input' });
  if (!omit.has('urlCheckStatus')) makeElement('urlCheckStatus', { tag: 'div', classes: ['validation-status'], text: '' });
  if (!omit.has('presetToggleBtn')) {
    makeElement('presetToggleBtn', { tag: 'button', attrs: { 'aria-haspopup': 'listbox', 'aria-expanded': 'false' } });
  }
  if (!omit.has('presetDropdown')) {
    const dropdown = makeElement('presetDropdown', { tag: 'div', style: { display: 'none' } });
    for (const [url, name] of options.presets ?? DEFAULT_PRESETS) {
      const item = new FakeElement(document, null, {
        tag: 'button',
        classes: ['preset-item'],
        attrs: { role: 'option', tabindex: '0' },
        dataset: { url },
      });
      // popup.html localizes preset names via data-i18n (preset_name_*);
      // unknown keys fall back to the span's own text, so this is safe for
      // custom presets too.
      const nameSpan = new FakeElement(document, null, {
        tag: 'span',
        classes: ['preset-name'],
        attrs: { 'data-i18n': `preset_name_${name.toLowerCase()}` },
        text: name,
      });
      item.appendChild(nameSpan);
      item.textContent = name;
      dropdown.appendChild(item);
    }
  }
  if (!omit.has('presetToggleText')) {
    makeElement('presetToggleText', { tag: 'span', attrs: { 'data-i18n': 'select_preset' }, text: 'Select Preset' });
  }
  if (!omit.has('toggleAdvanced')) {
    makeElement('toggleAdvanced', { tag: 'button', attrs: { 'aria-expanded': 'false', 'aria-controls': 'advancedOptions' } });
  }
  if (!omit.has('advancedOptions')) makeElement('advancedOptions', { tag: 'div', style: { display: 'none' } });
  if (!omit.has('debugLog')) makeElement('debugLog', { tag: 'input' });
  if (!omit.has('debugLogView')) makeElement('debugLogView', { tag: 'pre', text: 'Debug log is empty.' });
  if (!omit.has('refreshDebugLog')) makeElement('refreshDebugLog', { tag: 'button' });
  if (!omit.has('clearDebugLog')) makeElement('clearDebugLog', { tag: 'button' });
  if (!omit.has('copyDebugLog')) makeElement('copyDebugLog', { tag: 'button', text: 'Copy log' });

  state.el = Object.fromEntries(byId);
  state.document = document;
  state.body = document.body;
  state.presetItems = () => (state.el.presetDropdown ? state.el.presetDropdown.querySelectorAll('.preset-item') : []);
  state.fireDocument = (type, props = {}) => {
    const event = {
      type,
      target: props.target ?? document.body,
      key: props.key,
      ctrlKey: !!props.ctrlKey,
      metaKey: !!props.metaKey,
      defaultPrevented: false,
      _stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this._stopped = true; },
    };
    for (const fn of document._listeners[type] ?? []) fn(event);
    return event;
  };

  // --- Fake chrome ---------------------------------------------------------
  const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, cb) {
        state.sentMessages.push(message);
        const respond = (response, lastErrorMessage) => {
          chrome.runtime.lastError = lastErrorMessage ? { message: lastErrorMessage } : null;
          if (typeof cb === 'function') cb(response);
          chrome.runtime.lastError = null;
        };
        const handle = () => {
          switch (message.type) {
            case 'LOG_MESSAGE':
              respond(undefined, null);
              break;
            case 'UPDATE_RULES': {
              const mode = options.updateRulesResponse ?? 'ack';
              if (mode === 'no-receiver') respond(undefined, NO_RECEIVER);
              else if (mode === 'ack') respond({ success: true });
              else respond(mode, null);
              break;
            }
            case 'GET_DEBUG_LOG': {
              // Per-call queue first (for refresh tests that need a different
              // response than the init load), then the static option.
              const r = state.debugLogQueue.length
                ? state.debugLogQueue.shift()
                : (options.debugLogResponse ?? { success: true, entries: [], entriesDropped: 0, maxEntries: 200 });
              if (r === 'error') respond(undefined, NO_RECEIVER);
              else respond(r, null);
              break;
            }
            case 'CLEAR_DEBUG_LOG':
              respond(options.clearLogResponse ?? { success: true }, null);
              break;
            default:
              respond(undefined, NO_RECEIVER);
          }
        };
        if (options.asyncChrome) park(handle);
        else handle();
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          const run = () => {
            if (options.storageGetError) {
              chrome.runtime.lastError = { message: options.storageGetError };
              if (typeof cb === 'function') cb();
              chrome.runtime.lastError = null;
              return;
            }
            const out = {};
            for (const key of Object.keys(keys)) {
              out[key] = Object.prototype.hasOwnProperty.call(state.storage, key) ? state.storage[key] : keys[key];
            }
            chrome.runtime.lastError = null;
            if (typeof cb === 'function') cb(out);
          };
          if (options.asyncChrome) park(run);
          else run();
        },
        set(data, cb) {
          if (options.storageSetThrow) throw new Error('storage.local.set exploded');
          const run = () => {
            // A failed set (lastError) persists nothing — same as the real
            // chrome.storage.local.
            if (!options.storageSetError) Object.assign(state.storage, data);
            if (options.storageSetError) {
              chrome.runtime.lastError = { message: options.storageSetError };
              if (typeof cb === 'function') cb();
              chrome.runtime.lastError = null;
              return;
            }
            chrome.runtime.lastError = null;
            if (typeof cb === 'function') cb();
          };
          if (options.asyncChrome) park(run);
          else run();
        },
      },
    },
    i18n: options.i18nMessages ? {
      getMessage: (key) => options.i18nMessages[key] ?? '',
    } : undefined,
  };
  state.chrome = chrome;

  // --- Fake navigator (clipboard) -------------------------------------------
  const navigator = {};
  if (options.clipboard) {
    const writeText = typeof options.clipboard === 'function'
      ? options.clipboard
      : (text) => {
          state.clipboardWriteCalls.push(text);
          return options.clipboard === 'reject'
            ? Promise.reject(new Error('clipboard denied'))
            : Promise.resolve();
        };
    navigator.clipboard = { writeText };
  }
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true, writable: true });

  // --- Import the real popup.js and fire DOMContentLoaded --------------------
  globalThis.document = document;
  globalThis.chrome = chrome;
  const popupUrl = new URL('../QueryHop Extension/Resources/popup.js', import.meta.url).href;
  await import(`${popupUrl}?run=${++runId}`);
  for (const fn of document._listeners['DOMContentLoaded'] ?? []) {
    fn({ type: 'DOMContentLoaded' });
  }
  // Settle restoreOptions() / loadDebugLog() promise chains. In sync mode the
  // chrome callbacks already ran; the setImmediate flushes the promise
  // continuations. In asyncChrome mode the callbacks are parked in the fake
  // timer queue and each one schedules a further microtask, so alternate
  // drainParked (run one parked callback layer) with settle (flush the
  // microtasks it scheduled) until nothing is left. A fixed, generously large
  // iteration count is simpler than detecting quiescence and is always safe.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 16; i++) {
    state.drainParked();
    await settle();
  }
  return state;
}

// LOG_MESSAGE payloads the popup sent to the background.
export function logMessages(state) {
  return state.sentMessages
    .filter((m) => m.type === 'LOG_MESSAGE')
    .map((m) => m.payload);
}

// Error-level log messages (what handleError() surfaces to the background).
export function errorMessages(state) {
  return logMessages(state).filter((p) => p.level === 'error').map((p) => p.message);
}

// Flush microtasks/macrotasks so pending promise chains (async clipboard
// write, deferred chrome callbacks) settle.
export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
