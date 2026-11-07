// User-managed presets (issue #126): the add / rename / delete UI wiring of
// the real preset controller (popupPreset.js) driven through the real
// popup.js against the fake browser environment in tests/popup-harness.js.
// The pure CRUD decisions (addUserPreset / renameUserPreset /
// deleteUserPreset / normalizeUserPresets) are unit-tested in
// tests/popup-state.test.js; this file covers the DOM wiring around them:
// the form lifecycle, the immediate chrome.storage.local persistence, the
// row rendering below the built-ins, and the dropdown keyboard nav.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootPopup, logMessages } from './popup-harness.js';

const resourceDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'QueryHop Extension',
  'Resources',
);

const USER_URL = 'https://duckduckgo.com/?q=%s';
const ECOSIA_URL = 'https://www.ecosia.org/search?q=%s';

// Live user-preset rows only — scoped to the list element so re-rendered
// (detached) rows are never picked up by the harness's registry-wide
// document.querySelectorAll.
function userRows(state) {
  return state.el.presetUserList.querySelectorAll('.preset-item-user');
}

test('boots with no stored user presets: section hidden, list empty', async () => {
  const state = await bootPopup();

  assert.equal(state.el.presetUserSection.style.display, 'none');
  assert.equal(state.el.presetUserList.children.length, 0);
  assert.equal(state.el.presetAddForm.style.display, 'none');
  assert.equal(state.el.presetAddStatus.textContent, '');
  assert.equal(state.el.presetToggleText.textContent, 'Select Preset');
});

test('restores stored user presets below the built-ins on boot', async () => {
  const state = await bootPopup({
    storage: {
      userPresets: [
        { name: 'DuckDuckGo', url: USER_URL },
        { name: 'Ecosia', url: ECOSIA_URL },
      ],
    },
  });

  assert.equal(state.el.presetUserSection.style.display, 'block');
  const rows = userRows(state);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.url, USER_URL);
  assert.equal(rows[0].querySelector('.preset-name').textContent, 'DuckDuckGo');
  assert.ok(rows[0].querySelector('.preset-rename'), 'each row carries a rename action');
  assert.ok(rows[0].querySelector('.preset-delete'), 'each row carries a delete action');
  assert.equal(rows[1].querySelector('.preset-name').textContent, 'Ecosia');
  // Built-ins first, user rows after — the flat .preset-item list the
  // keyboard nav walks.
  const items = state.presetItems();
  assert.equal(items.length, 4);
  assert.equal(items[2], rows[0]);
  assert.equal(items[3], rows[1]);
});

test('restores a corrupt stored user-presets payload as empty', async () => {
  const state = await bootPopup({
    storage: { userPresets: [null, 42, { name: 'NoUrl' }, { url: USER_URL }] },
  });

  assert.equal(state.el.presetUserSection.style.display, 'none');
  assert.equal(state.el.presetUserList.children.length, 0);
});

test('Add opens the form, prefilled from the main URL field', async () => {
  const state = await bootPopup();
  state.el.searchUrl.value = 'https://example.com/search?q=%s';

  state.el.presetAddBtn.click();

  assert.equal(state.el.presetAddForm.style.display, 'block');
  assert.equal(state.el.presetAddName.value, '');
  assert.equal(state.el.presetAddUrl.value, 'https://example.com/search?q=%s', 'the current URL is offered as a starting point');
  assert.equal(state.el.presetAddStatus.textContent, '');
  assert.equal(state.document.activeElement, state.el.presetAddName, 'focus lands on the name field');
});

test('Cancel closes the form without persisting', async () => {
  const state = await bootPopup();
  state.el.presetAddBtn.click();
  state.el.presetAddName.value = 'Ghost';
  state.el.presetAddUrl.value = USER_URL;

  state.el.presetAddCancel.click();

  assert.equal(state.el.presetAddForm.style.display, 'none');
  assert.equal(state.el.presetAddStatus.textContent, '');
  assert.equal(state.storage.userPresets, undefined, 'no storage write on cancel');
  assert.equal(userRows(state).length, 0);
  assert.equal(state.document.activeElement, state.el.presetAddBtn, 'focus returns to the Add button');
});

test('Save adds the preset: trimmed, persisted, rendered, logged, form closed', async () => {
  const state = await bootPopup();
  state.el.searchUrl.value = USER_URL;
  state.el.presetAddBtn.click();
  state.el.presetAddName.value = ' DuckDuckGo ';
  state.el.presetAddUrl.value = `  ${USER_URL}  `;

  state.el.presetAddSave.click();

  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: USER_URL }]);
  assert.equal(state.el.presetAddForm.style.display, 'none');
  assert.equal(state.el.presetAddStatus.textContent, '');
  const rows = userRows(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.url, USER_URL);
  assert.equal(rows[0].querySelector('.preset-name').textContent, 'DuckDuckGo');
  assert.ok(logMessages(state).some((p) => p.message === 'Preset added: DuckDuckGo'));
  // The main URL field matches the new preset → the toggle shows its name.
  assert.equal(state.el.presetToggleText.textContent, 'DuckDuckGo');
});

// ---------------------------------------------------------------------------
// Enter-to-save in the add form (issue #139): the main URL field saves on
// Enter (popupSave.js), so the add form's two inputs get the same contract.
// ---------------------------------------------------------------------------

test('Add form: Enter in the name field saves the preset (issue #139)', async () => {
  const state = await bootPopup();
  state.el.presetAddBtn.click();
  state.el.presetAddName.value = 'DuckDuckGo';
  state.el.presetAddUrl.value = USER_URL;

  state.el.presetAddName.dispatchEvent('keydown', { key: 'Enter' });

  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: USER_URL }]);
  assert.equal(state.el.presetAddForm.style.display, 'none', 'the form closes on a valid save');
  assert.ok(logMessages(state).some((p) => p.message === 'Preset added: DuckDuckGo'));
});

test('Add form: Enter in the URL field saves the preset (issue #139)', async () => {
  const state = await bootPopup();
  state.el.presetAddBtn.click();
  state.el.presetAddName.value = 'DuckDuckGo';
  state.el.presetAddUrl.value = USER_URL;

  state.el.presetAddUrl.dispatchEvent('keydown', { key: 'Enter' });

  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: USER_URL }]);
  assert.equal(state.el.presetAddForm.style.display, 'none');
});

test('Add form: Enter on a blank name refuses and keeps the form open (issue #139)', async () => {
  const state = await bootPopup();
  state.el.presetAddBtn.click();
  state.el.presetAddName.value = '   ';
  state.el.presetAddUrl.value = USER_URL;

  state.el.presetAddUrl.dispatchEvent('keydown', { key: 'Enter' });

  assert.equal(state.storage.userPresets, undefined, 'nothing persisted on failure');
  assert.equal(state.el.presetAddForm.style.display, 'block', 'the form stays open for correction');
  assert.equal(state.el.presetAddStatus.className, 'validation-status invalid');
  assert.equal(state.el.presetAddStatus.textContent, 'Preset name cannot be empty');
});

test('Save with a blank name → missing-name status, form stays open', async () => {
  const state = await bootPopup();
  state.el.presetAddBtn.click();
  state.el.presetAddName.value = '   ';
  state.el.presetAddUrl.value = USER_URL;

  state.el.presetAddSave.click();

  assert.equal(state.el.presetAddStatus.className, 'validation-status invalid');
  assert.equal(state.el.presetAddStatus.textContent, 'Preset name cannot be empty');
  assert.equal(state.el.presetAddForm.style.display, 'block', 'the form stays open for correction');
  assert.equal(state.storage.userPresets, undefined, 'nothing persisted on failure');
});

test('Save with a duplicate URL → duplicate status, no second row', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });
  state.el.presetAddBtn.click();
  state.el.presetAddName.value = 'Another DDG';
  state.el.presetAddUrl.value = USER_URL;

  state.el.presetAddSave.click();

  assert.equal(state.el.presetAddStatus.textContent, 'That URL is already in your presets');
  assert.equal(userRows(state).length, 1);
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: USER_URL }]);
});

test('Save with an unvalidated URL → the main field’s validator message', async () => {
  const state = await bootPopup();
  state.el.presetAddBtn.click();
  state.el.presetAddName.value = 'NoPlaceholder';
  state.el.presetAddUrl.value = 'https://example.com/search?q=';

  state.el.presetAddSave.click();

  assert.equal(state.el.presetAddStatus.textContent, 'URL must include %s in place of your query');
  assert.equal(state.storage.userPresets, undefined);
});

test('Unsafe mode bypasses the %s/http(s) rules; blocked schemes are still refused', async () => {
  const state = await bootPopup();
  state.el.unsafeMode.checked = true;
  state.el.presetAddBtn.click();
  state.el.presetAddName.value = 'Raw';
  state.el.presetAddUrl.value = 'https://example.com/no-placeholder';

  state.el.presetAddSave.click();
  assert.deepEqual(state.storage.userPresets, [{ name: 'Raw', url: 'https://example.com/no-placeholder' }]);

  state.el.presetAddBtn.click();
  state.el.presetAddName.value = 'Evil';
  state.el.presetAddUrl.value = 'javascript:alert(1)';
  state.el.presetAddSave.click();

  assert.equal(state.el.presetAddStatus.textContent, 'URL scheme is not allowed, even in unsafe mode');
  assert.equal(userRows(state).length, 1, 'the blocked preset was never added');
  assert.deepEqual(state.storage.userPresets, [{ name: 'Raw', url: 'https://example.com/no-placeholder' }]);
});

test('Rename: Enter commits through the pure renamer and persists', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });
  const row = userRows(state)[0];

  row.querySelector('.preset-rename').click();

  const input = row.querySelector('.preset-rename-input');
  assert.ok(input, 'the name span was swapped for an edit input');
  assert.equal(input.value, 'DuckDuckGo');
  assert.equal(state.document.activeElement, input, 'the edit input is focused');

  input.value = 'DDG';
  input.dispatchEvent('keydown', { key: 'Enter' });

  assert.deepEqual(state.storage.userPresets, [{ name: 'DDG', url: USER_URL }]);
  const rows = userRows(state);
  assert.equal(rows[0].querySelector('.preset-name').textContent, 'DDG');
  assert.equal(rows[0].querySelector('.preset-rename-input'), null, 'the input is gone after the re-render');
  assert.ok(logMessages(state).some((p) => p.message === 'Preset renamed: DDG'));
});

// ---------------------------------------------------------------------------
// Rename input key isolation (issue #138): every keypress in the edit input
// must stay local to it. The listbox keydown handler (container-level)
// preventDefaults Space / ArrowUp / ArrowDown — while a name is being
// edited that swallows the space character and kills the caret movement.
// ---------------------------------------------------------------------------

test('Rename: Space in the edit input is typed locally, not swallowed (issue #138)', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });

  const row = userRows(state)[0];
  row.querySelector('.preset-rename').click();
  const input = row.querySelector('.preset-rename-input');

  const event = input.dispatchEvent('keydown', { key: ' ' });

  assert.equal(
    event.defaultPrevented,
    false,
    'the listbox handler must not preventDefault Space — a space has to be typable in the name',
  );
  assert.equal(state.document.activeElement, input, 'focus stays in the edit input');
});

test('Rename: arrows in the edit input keep the caret, not the listbox (issue #138)', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });

  const row = userRows(state)[0];
  row.querySelector('.preset-rename').click();
  const input = row.querySelector('.preset-rename-input');

  const down = input.dispatchEvent('keydown', { key: 'ArrowDown' });
  assert.equal(down.defaultPrevented, false, 'ArrowDown must keep its default caret move');
  const up = input.dispatchEvent('keydown', { key: 'ArrowUp' });
  assert.equal(up.defaultPrevented, false, 'ArrowUp must keep its default caret move');
  assert.equal(state.document.activeElement, input, 'focus stays in the edit input');
});

test('Rename: Escape cancels, and a blank name is refused', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });

  let row = userRows(state)[0];
  row.querySelector('.preset-rename').click();
  row.querySelector('.preset-rename-input').dispatchEvent('keydown', { key: 'Escape' });
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: USER_URL }]);
  assert.equal(userRows(state)[0].querySelector('.preset-name').textContent, 'DuckDuckGo');

  // A blank rename is refused — nothing persists. Per #141 the refusal is
  // no longer a silent re-render: the edit input stays open (the name span
  // is not restored) and the reason is surfaced in the manage status line.
  row = userRows(state)[0];
  row.querySelector('.preset-rename').click();
  const input = row.querySelector('.preset-rename-input');
  input.value = '   ';
  input.dispatchEvent('keydown', { key: 'Enter' });
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: USER_URL }]);
  assert.ok(row.querySelector('.preset-rename-input'), 'the edit input stays open on a refused rename');
  assert.equal(row.querySelector('.preset-name'), null, 'the name span is not restored while the edit is open');
  assert.equal(state.el.presetManageStatus.textContent, 'Preset name cannot be empty');
});

test('Rename: a blank rename is refused visibly, and the edit stays open (issue #141)', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });

  const row = userRows(state)[0];
  row.querySelector('.preset-rename').click();
  const input = row.querySelector('.preset-rename-input');
  input.value = '   ';
  input.dispatchEvent('keydown', { key: 'Enter' });

  // Nothing persisted...
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: USER_URL }]);
  // ...the refusal is visible in the manage status line (aria-live)...
  assert.equal(state.el.presetManageStatus.className, 'validation-status invalid');
  assert.equal(state.el.presetManageStatus.textContent, 'Preset name cannot be empty');
  // ...and the edit input stays open with focus, so the name can be
  // corrected and retried.
  const stillOpen = row.querySelector('.preset-rename-input');
  assert.ok(stillOpen, 'the edit input stays open on a refused rename');
  assert.equal(state.document.activeElement, stillOpen, 'focus stays in the input');

  // A corrected name then commits and the status clears.
  stillOpen.value = 'DDG';
  stillOpen.dispatchEvent('keydown', { key: 'Enter' });
  assert.deepEqual(state.storage.userPresets, [{ name: 'DDG', url: USER_URL }]);
  assert.equal(state.el.presetManageStatus.textContent, '', 'the error status clears on a successful rename');
  assert.equal(userRows(state)[0].querySelector('.preset-name').textContent, 'DDG');
});

test('Delete removes the preset, persists, and hides the section when empty', async () => {
  const state = await bootPopup({
    storage: { userPresets: [
      { name: 'DuckDuckGo', url: USER_URL },
      { name: 'Ecosia', url: ECOSIA_URL },
    ] },
  });

  userRows(state)[0].querySelector('.preset-delete').click();

  assert.deepEqual(state.storage.userPresets, [{ name: 'Ecosia', url: ECOSIA_URL }]);
  assert.equal(userRows(state).length, 1);
  assert.equal(userRows(state)[0].querySelector('.preset-name').textContent, 'Ecosia', 'the survivor keeps its position');
  assert.ok(logMessages(state).some((p) => p.message === 'Preset deleted: DuckDuckGo'));

  userRows(state)[0].querySelector('.preset-delete').click();

  assert.deepEqual(state.storage.userPresets, []);
  assert.equal(userRows(state).length, 0);
  assert.equal(state.el.presetUserSection.style.display, 'none', 'empty list → section hidden again');
});

// ---------------------------------------------------------------------------
// Two-stage delete (issue #142): a misclick on ✕ must not destroy the
// user's data. The first click ARMS the button (it turns into a localized
// "Sure?" confirm state for a few seconds, disclosed via the aria-live
// manage status line); the second click within the window deletes. An
// outside click or the elapsing window disarms without deleting.
// ---------------------------------------------------------------------------

test('Delete is two-stage: first click arms, second click deletes (issue #142)', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });
  state.el.presetToggleBtn.click();
  state.tick(50);

  const row = userRows(state)[0];
  const del = row.querySelector('.preset-delete');

  // First click: arms — the preset is NOT deleted yet, the button enters its
  // confirm state, and the aria-live status line discloses the armed state.
  del.click();
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: USER_URL }], 'arming does not delete');
  assert.equal(userRows(state).length, 1, 'the row is still present while armed');
  assert.ok(del.classList.contains('preset-delete-armed'), 'the delete button enters its armed state');
  assert.notEqual(del.textContent, '✕', 'the armed button no longer shows the plain ✕');
  assert.match(state.el.presetManageStatus.textContent, /DuckDuckGo/, 'the armed-state disclosure names the preset');

  // Second click within the window: confirms — the preset is deleted,
  // persisted, and the armed styling is gone.
  del.click();
  assert.deepEqual(state.storage.userPresets, []);
  assert.equal(userRows(state).length, 0);
  assert.ok(logMessages(state).some((p) => p.message === 'Preset deleted: DuckDuckGo'));
});

test('Delete: clicking elsewhere cancels the armed delete (issue #142)', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });
  state.el.presetToggleBtn.click();
  state.tick(50);

  const row = userRows(state)[0];
  const del = row.querySelector('.preset-delete');
  del.click(); // arm
  assert.ok(del.classList.contains('preset-delete-armed'), 'armed');

  // Click somewhere outside the armed button (the search field) cancels.
  state.fireDocument('click', { target: state.el.searchUrl });
  assert.ok(!del.classList.contains('preset-delete-armed'), 'the outside click disarms the delete');
  assert.equal(del.textContent, '✕', 'the button returns to the plain ✕');
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: USER_URL }], 'nothing was deleted');
});

test('Delete: the armed state auto-disarms after the window (issue #142)', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });
  state.el.presetToggleBtn.click();
  state.tick(50);

  const row = userRows(state)[0];
  const del = row.querySelector('.preset-delete');
  del.click(); // arm
  assert.ok(del.classList.contains('preset-delete-armed'), 'armed');

  state.tick(3000); // the arm window elapses

  assert.ok(!del.classList.contains('preset-delete-armed'), 'the arm auto-disarms after the window');
  assert.deepEqual(state.storage.userPresets, [{ name: 'DuckDuckGo', url: USER_URL }], 'nothing was deleted');
});

test('a user preset row applies to the URL field like a built-in one', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });

  state.el.presetToggleBtn.click();
  state.tick(50); // the 50ms first-item focus delay

  assert.equal(state.el.presetDropdown.style.display, 'block');
  userRows(state)[0].click();

  assert.equal(state.el.searchUrl.value, USER_URL);
  assert.equal(state.el.presetDropdown.style.display, 'none', 'the dropdown closes on apply');
  assert.equal(state.el.presetToggleText.textContent, 'DuckDuckGo', 'the toggle label follows the applied preset');
  assert.equal(state.document.activeElement, state.el.searchUrl, 'focus returns to the URL field');
  assert.ok(logMessages(state).some((p) => p.message === 'Preset applied: DuckDuckGo'));
});

test('keyboard nav reaches the user rows after the built-ins, and Enter applies', async () => {
  const state = await bootPopup({ storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] } });

  state.el.presetToggleBtn.click();
  state.tick(50);

  const items = state.presetItems();
  assert.equal(items.length, 3, 'two built-ins + one user row');
  assert.equal(state.document.activeElement, items[0], 'the first built-in is focused on open');

  state.el.presetDropdown.dispatchEvent('keydown', { key: 'ArrowDown' });
  assert.equal(state.document.activeElement, items[1]);
  state.el.presetDropdown.dispatchEvent('keydown', { key: 'ArrowDown' });
  assert.equal(state.document.activeElement, items[2], 'the nested user row is reachable via ArrowDown');

  // Enter on the focused user row applies it (row click, no double fire).
  state.el.presetDropdown.dispatchEvent('keydown', { key: 'Enter' });
  assert.equal(state.el.searchUrl.value, USER_URL);
  assert.equal(state.el.presetDropdown.style.display, 'none');
});

// ---------------------------------------------------------------------------
// aria-selected on the ARIA listbox options (issue #134)
// ---------------------------------------------------------------------------

const KAGI_URL = 'https://kagi.com/search?q=%s';

function ariaStates(state) {
  return [...state.el.presetDropdown.querySelectorAll('.preset-item')].map(
    (item) => item.getAttribute('aria-selected'),
  );
}

test('aria-selected: no match on boot — every option is false', async () => {
  const state = await bootPopup();

  assert.deepEqual(ariaStates(state), ['false', 'false'], 'default storage URL matches no preset');
});

test('aria-selected: a stored URL that matches a built-in marks exactly that option', async () => {
  const state = await bootPopup({ storage: { customSearchUrl: KAGI_URL } });

  const items = state.presetItems();
  assert.equal(items.length, 2);
  // Harness default presets are [Kagi, Brave] — Kagi is the first option.
  assert.deepEqual(ariaStates(state), ['true', 'false']);
});

test('aria-selected: a stored URL matching a user preset marks only the user row', async () => {
  const state = await bootPopup({
    storage: {
      customSearchUrl: USER_URL,
      userPresets: [
        { name: 'DuckDuckGo', url: USER_URL },
        { name: 'Ecosia', url: ECOSIA_URL },
      ],
    },
  });

  const items = state.presetItems();
  // Two harness built-ins (Kagi, Brave) + two user rows.
  assert.equal(items.length, 4);
  assert.deepEqual(ariaStates(state), ['false', 'false', 'true', 'false']);
});

test('aria-selected: clicking a built-in moves the selection', async () => {
  const state = await bootPopup({ storage: { customSearchUrl: KAGI_URL } });

  state.el.presetToggleBtn.click();
  state.tick(50);
  const items = state.presetItems();
  // Harness default presets are [Kagi, Brave] — Kagi starts selected.
  assert.deepEqual(ariaStates(state), ['true', 'false']);

  items[1].click(); // Brave

  assert.equal(state.el.searchUrl.value, 'https://search.brave.com/search?q=%s');
  assert.deepEqual(ariaStates(state), ['false', 'true']);
});

test('aria-selected: applying a user preset via click moves the selection to the row', async () => {
  const state = await bootPopup({
    storage: { userPresets: [{ name: 'DuckDuckGo', url: USER_URL }] },
  });

  state.el.presetToggleBtn.click();
  state.tick(50);
  userRows(state)[0].click();

  const items = state.presetItems();
  // Two harness built-ins (Kagi, Brave) + one user row.
  assert.equal(items.length, 3);
  assert.deepEqual(ariaStates(state), ['false', 'false', 'true']);
});

test('aria-selected: typing a custom URL that matches nothing clears the selection', async () => {
  const state = await bootPopup({ storage: { customSearchUrl: KAGI_URL } });

  state.el.searchUrl.value = 'https://example.com/search?q=%s';
  state.el.searchUrl.dispatchEvent('input', {});
  state.tick(300); // INPUT_DEBOUNCE_DELAY

  assert.deepEqual(ariaStates(state), ['false', 'false']);
  assert.equal(state.el.presetToggleText.textContent, 'Select Preset');
});

test('aria-selected: Enter on the focused option updates the state, not just the label', async () => {
  const state = await bootPopup();

  state.el.presetToggleBtn.click();
  state.tick(50);
  const items = state.presetItems();
  assert.equal(state.document.activeElement, items[0], 'first built-in focused on open');
  assert.deepEqual(ariaStates(state), ['false', 'false'], 'nothing selected before Enter');

  state.el.presetDropdown.dispatchEvent('keydown', { key: 'Enter' });

  assert.equal(state.el.searchUrl.value, KAGI_URL);
  assert.deepEqual(ariaStates(state), ['true', 'false']);
});

test('aria-selected: adding a user preset marks the new row selected', async () => {
  const state = await bootPopup();
  state.el.searchUrl.value = USER_URL;

  state.el.presetAddBtn.click();
  state.el.presetAddName.value = 'DuckDuckGo';
  state.el.presetAddUrl.value = USER_URL;
  state.el.presetAddSave.click();

  assert.equal(userRows(state)[0].getAttribute('aria-selected'), 'true');
  assert.deepEqual(
    ariaStates(state).slice(0, 2),
    ['false', 'false'],
    'the built-ins are deselected by the sync that follows the add',
  );
});

test('aria-selected: the static markup ships aria-selected="false" on every built-in', async () => {
  const state = await bootPopup();
  const html = fs.readFileSync(path.join(resourceDir, 'popup.html'), 'utf8');
  const optionBlocks = html.matchAll(/<button\b[^>]*\brole="option"[^>]*>/g);
  const staticOptions = [...optionBlocks].map((m) => m[0]);
  assert.equal(staticOptions.length, 11, 'the eleven built-in options in popup.html');
  for (const tag of staticOptions) {
    assert.ok(
      /\baria-selected="false"/.test(tag),
      `built-in option ${tag.slice(0, 60)}... ships without the aria-selected="false" baseline`,
    );
  }
  // The harness mirrors the static markup, so a fresh boot already carries
  // the attribute before any interaction.
  assert.equal(
    state.el.presetDropdown.children[0].getAttribute('aria-selected'),
    'false',
  );
});
