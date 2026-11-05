// Test-harness fidelity guard (issue #131).
//
// The popup-harness fake DOM must mirror the REAL DOM's contract for
// querySelectorAll: it returns a NodeList, which is ArrayLike (length,
// numeric indices, item()) and iterable (forEach, for...of, spread) but
// carries NO Array.prototype methods — no indexOf, map, filter, find,
// slice, includes, or join.
//
// Why this guard exists: the harness originally returned a plain Array
// (Array.prototype.filter). popupPreset.js's preset-dropdown arrow-key
// navigation then called .indexOf() on the qsa result — legal on an
// Array, a TypeError on a real browser's NodeList. Every unit test passed;
// the bug shipped. Making the harness NodeList-shaped exposed it
// (tests/popup-init-restore.test.js and tests/popup-user-presets.test.js
// keyboard-nav tests failed with the exact production error), and this
// file pins the shape so a future harness "cleanup" back to an Array
// cannot silently re-mask the same bug class.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootPopup } from './popup-harness.js';

// The method surface a real NodeList exposes for iteration / indexing.
const NODELIST_METHODS = ['item', 'forEach', 'entries', 'keys', 'values'];

// Array.prototype methods a real NodeList does NOT have. If the harness
// offers any of these, tests can lean on them while the shipped code
// throws in the browser — exactly the #131 failure mode.
const ARRAY_ONLY_METHODS = [
  'indexOf',
  'lastIndexOf',
  'map',
  'filter',
  'find',
  'findIndex',
  'some',
  'every',
  'reduce',
  'slice',
  'splice',
  'includes',
  'join',
  'flat',
  'fill',
  'push',
  'pop',
  'sort',
];

test('harness querySelectorAll returns a NodeList-shaped result (not an Array)', async () => {
  const state = await bootPopup();
  const list = state.el.presetDropdown.querySelectorAll('.preset-item');

  // Not an Array — that is the whole point.
  assert.equal(Array.isArray(list), false, 'qsa result must not be an Array');

  // ArrayLike: length + numeric indices.
  assert.equal(list.length, 2);
  assert.equal(list[0], state.el.presetDropdown.children[0]);
  assert.equal(list[1], state.el.presetDropdown.children[1]);

  // item() and the spec iteration surface exist.
  assert.equal(typeof list.item, 'function');
  assert.equal(list.item(0), list[0]);
  assert.equal(list.item(2), null, 'item() out of range yields null');
  for (const method of NODELIST_METHODS) {
    assert.equal(typeof list[method], 'function', `NodeList exposes ${method}()`);
  }

  // Enumerable: for...of and spread both work.
  assert.deepEqual([...list], [list[0], list[1]]);
  let seen = 0;
  for (const item of list) {
    assert.ok(state.el.presetDropdown.children.includes(item));
    seen += 1;
  }
  assert.equal(seen, list.length);

  // And none of the array-only methods leak in.
  for (const method of ARRAY_ONLY_METHODS) {
    assert.equal(
      typeof list[method],
      'undefined',
      `harness qsa result must not expose Array.prototype.${method}() — ` +
        'that is how #131 (popupPreset.js calling .indexOf on a qsa result) ' +
        'went green in tests and threw in the browser',
    );
  }
});

test('harness document-level querySelectorAll is NodeList-shaped too', async () => {
  const state = await bootPopup();
  const list = state.document.querySelectorAll('.preset-item');

  assert.equal(Array.isArray(list), false);
  assert.equal(list.length, 2, 'the two default built-in presets');
  assert.equal(typeof list.item, 'function');
  assert.equal(list.item(0), list[0]);
  assert.deepEqual([...list].map((el) => el.dataset.url), [
    'https://kagi.com/search?q=%s',
    'https://search.brave.com/search?q=%s',
  ]);
  for (const method of ARRAY_ONLY_METHODS) {
    assert.equal(typeof list[method], 'undefined', `document.qsa must not expose ${method}()`);
  }
});

test('the arrow-key handlers survive the NodeList shape (regression, issue #131)', async () => {
  // The shipped code (popupPreset.js) runs against the harness's fake DOM.
  // Before the fix, the first ArrowDown dispatched here threw
  // "items.indexOf is not a function" — the exact TypeError users hit in
  // a real browser. This test dispatches both directions through the real
  // controller and asserts focus moved, so any re-introduction of an
  // array-only call on the qsa result fails here.
  const state = await bootPopup();
  state.el.presetToggleBtn.click();
  state.tick(50); // the 50ms focus delay
  const items = state.el.presetDropdown.querySelectorAll('.preset-item');
  assert.equal(state.document.activeElement, items[0]);

  // Down twice, up twice: exercises both branches of the handler.
  state.el.presetDropdown.dispatchEvent('keydown', { key: 'ArrowDown' });
  assert.equal(state.document.activeElement, items[1], 'ArrowDown reaches the second preset');
  state.el.presetDropdown.dispatchEvent('keydown', { key: 'ArrowDown' });
  assert.equal(state.document.activeElement, items[1], 'past the end, focus holds');

  state.el.presetDropdown.dispatchEvent('keydown', { key: 'ArrowUp' });
  assert.equal(state.document.activeElement, items[0], 'ArrowUp walks back');
  state.el.presetDropdown.dispatchEvent('keydown', { key: 'ArrowUp' });
  assert.equal(state.el.presetDropdown.style.display, 'none', 'ArrowUp on the first closes');
  assert.equal(state.document.activeElement, state.el.presetToggleBtn);
});
