//
// popup-log-fallback.test.js
//
// The #92 popup side: popupCore.js logToBackground() falls back to a direct
// console call when the LOG_MESSAGE send to the service worker fails
// (worker asleep, tab race, chrome.runtime gone). That fallback used to
// index console[level] with an unvalidated, caller-supplied level —
// console[undefined] throws a TypeError inside the catch block and the log
// line is silently lost, exactly the failure the fallback exists to
// survive.
//
// The fix routes the level through bgCommon.js consoleMethodFor(), the same
// resolver the worker-side logMessage() and the LOG_MESSAGE relay use:
// unknown or missing levels fall back to console.log instead of throwing.
//
// createPopupCore() is imported directly (the module is chrome-free at
// import time — chrome.runtime is only touched inside logToBackground's
// try block, which is what we drive here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPopupCore } from '../QueryHop Extension/Resources/popupCore.js';
import { consoleMethodFor } from '../QueryHop Extension/Resources/bgCommon.js';

function makeCoreWithThrowingSend() {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage() {
        throw new Error('service worker unavailable');
      },
    },
  };
  const core = createPopupCore({
    elements: {},
    localizedValidationMessage: (m) => m,
  });
  return { core, previousChrome };
}

function captureConsole() {
  const seen = { log: [], warn: [], error: [] };
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const method of ['log', 'warn', 'error']) {
    console[method] = (...args) => seen[method].push(args);
  }
  return {
    seen,
    restore() {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}

test('#92: popup fallback with a broken send routes to the right console method', () => {
  const { core, previousChrome } = makeCoreWithThrowingSend();
  const cap = captureConsole();
  try {
    core.logToBackground('warn', 'send failed, falling back');
    core.logToBackground('error', 'send failed, falling back', { detail: 1 });
    core.logToBackground('log', 'send failed, falling back');
  } finally {
    cap.restore();
    globalThis.chrome = previousChrome;
  }
  assert.equal(cap.seen.warn.length, 1);
  assert.equal(cap.seen.error.length, 1);
  assert.equal(cap.seen.log.length, 1);
  for (const method of ['warn', 'error', 'log']) {
    assert.ok(
      cap.seen[method][0][0].startsWith('[POPUP FALLBACK]'),
      `${method} fallback line keeps the [POPUP FALLBACK] marker`
    );
  }
  assert.deepEqual(cap.seen.error[0][1], { detail: 1 });
});

test('#92: popup fallback never throws for unknown or missing levels (no console[undefined])', () => {
  const { core, previousChrome } = makeCoreWithThrowingSend();
  const cap = captureConsole();
  try {
    // The exact #92 boundary: level comes from a message payload, not from
    // this file — a hostile or buggy value must degrade to console.log.
    assert.doesNotThrow(() => core.logToBackground('speak-loud', 'unknown level'));
    assert.doesNotThrow(() => core.logToBackground(undefined, 'missing level'));
    assert.doesNotThrow(() => core.logToBackground('', 'empty level'));
  } finally {
    cap.restore();
    globalThis.chrome = previousChrome;
  }
  assert.equal(cap.seen.log.length, 3, 'all unknown levels fall back to console.log');
  assert.equal(cap.seen.warn.length, 0);
  assert.equal(cap.seen.error.length, 0);
});

test('consoleMethodFor: the shared resolver maps known levels and degrades for unknown', () => {
  // The worker relay and logMessage rely on this mapping — pin it so a
  // future edit cannot quietly re-introduce console[undefined] anywhere.
  assert.equal(consoleMethodFor('log'), 'log');
  assert.equal(consoleMethodFor('warn'), 'warn');
  assert.equal(consoleMethodFor('error'), 'error');
  for (const level of ['speak', '', undefined, null, {}, [], 42]) {
    assert.equal(consoleMethodFor(level), 'log', `level ${String(level)} falls back to log`);
  }
});

test('#92: a healthy send does not touch the console at all', () => {
  const sent = [];
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg) {
        sent.push(msg);
      },
    },
  };
  const core = createPopupCore({
    elements: {},
    localizedValidationMessage: (m) => m,
  });
  const cap = captureConsole();
  try {
    core.logToBackground('warn', 'worker is fine');
  } finally {
    cap.restore();
    globalThis.chrome = previousChrome;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'LOG_MESSAGE');
  assert.equal(sent[0].payload.level, 'warn');
  assert.equal(sent[0].payload.source, 'popup');
  assert.equal(cap.seen.log.length + cap.seen.warn.length + cap.seen.error.length, 0,
    'no console output when the send succeeds');
});
