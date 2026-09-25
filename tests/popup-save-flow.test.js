// Save-flow coverage for the REAL popup.js (issue #38; regression guard for
// #37). Drives the actual save handler — button click, Enter keydown in the
// URL input, and the Ctrl/Cmd+S shortcut — against a fake chrome environment
// (tests/popup-harness.js) and asserts on the storage payload, the runtime
// messages the popup sent and the save-button feedback states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootPopup, logMessages, errorMessages } from './popup-harness.js';

const VALID_URL = 'https://example.com/search?q=%s';

test('persists the settings payload and flashes success when the background acknowledges', async () => {
  const state = await bootPopup(); // updateRulesResponse defaults to 'ack'
  state.el.searchUrl.value = VALID_URL;
  state.el.enableExtension.checked = true; // keep the extension enabled → plain success, no disabled reminder
  state.el.save.click();

  assert.deepEqual(state.storage, {
    customSearchUrl: VALID_URL,
    allowUnsafeMode: false,
    extensionEnabled: true,
    debugLogEnabled: false,
  });
  assert.equal(state.el.save.textContent, 'Saved!');
  assert.ok(state.el.save.classList.contains('success-flash'));
  assert.equal(state.el.save.disabled, false);
  assert.ok(state.sentMessages.some((m) => m.type === 'UPDATE_RULES'));
  assert.ok(logMessages(state).some((p) => p.message === 'Background script acknowledged settings update'));
});

test('#37: a missing UPDATE_RULES acknowledgement surfaces as an error, not success', async () => {
  // No receiver (extension mid-reload): storage set already succeeded, but
  // the background never acknowledged — so its settings cache was never
  // invalidated and the OLD rules stay live until the TTL expires. The UI
  // must not claim success in that case (regression guard for #37).
  const state = await bootPopup({ updateRulesResponse: 'no-receiver' });
  state.el.searchUrl.value = VALID_URL;
  state.el.enableExtension.checked = true;
  state.el.save.click();

  assert.equal(state.storage.customSearchUrl, VALID_URL, 'the settings did land in storage');
  assert.equal(state.el.save.textContent, 'Error!');
  assert.ok(state.el.save.classList.contains('error-flash'));
  assert.ok(!state.el.save.classList.contains('success-flash'));
  assert.equal(state.el.save.disabled, false);
  assert.ok(errorMessages(state).some((m) => m.includes('did not acknowledge the update')));
  assert.ok(logMessages(state).some((p) => p.message === 'Background script did not acknowledge settings update'));
});

test('#37: an explicit response without success is treated like a missing ack', async () => {
  const state = await bootPopup({ updateRulesResponse: { saved: true } });
  state.el.searchUrl.value = VALID_URL;
  state.el.save.click();

  assert.equal(state.el.save.textContent, 'Error!');
  assert.ok(state.el.save.classList.contains('error-flash'));
  assert.ok(errorMessages(state).some((m) => m.includes('did not acknowledge the update')));
});

test('flashes the disabled-reminder state when the save auto-disables the extension', async () => {
  const state = await bootPopup();
  state.el.enableExtension.checked = true; // URL stays empty → auto-disable
  state.el.save.click();

  assert.equal(state.el.enableExtension.checked, false, 'the checkbox is flipped in the UI');
  assert.deepEqual(state.storage, {
    customSearchUrl: '',
    allowUnsafeMode: false,
    extensionEnabled: false,
    debugLogEnabled: false,
  });
  assert.equal(state.el.save.textContent, 'Saved! (Disabled)');
  assert.ok(state.el.save.classList.contains('warning-flash'));
  assert.ok(logMessages(state).some((p) => p.message === 'Extension auto-disabled due to empty URL.'));
});

test('shows Saving... while the async round-trip is in flight, then success', async () => {
  const state = await bootPopup({ asyncChrome: true });
  state.el.searchUrl.value = VALID_URL;
  state.el.enableExtension.checked = true;
  state.el.save.click();

  assert.equal(state.el.save.textContent, 'Saving...');
  assert.equal(state.el.save.disabled, true);

  state.flushNext(); // storage.set callback
  assert.equal(state.el.save.textContent, 'Saving...'); // UPDATE_RULES not acknowledged yet
  assert.equal(state.el.save.disabled, true);

  state.flushNext(); // the parked LOG_MESSAGE from logInfo() before the rules update
  assert.equal(state.el.save.textContent, 'Saving...'); // still no ack

  state.flushNext(); // UPDATE_RULES callback (ack)
  assert.equal(state.el.save.textContent, 'Saved!');
  assert.equal(state.el.save.disabled, false);
});

test('flashes an error when chrome.storage.local.set reports lastError', async () => {
  const state = await bootPopup({ storageSetError: 'Quota exceeded' });
  state.el.searchUrl.value = VALID_URL;
  state.el.save.click();

  assert.equal(state.el.save.textContent, 'Error!');
  assert.ok(state.el.save.classList.contains('error-flash'));
  assert.equal(state.el.save.disabled, false);
  assert.equal(state.storage.customSearchUrl, undefined, 'a failed set persists nothing');
  assert.ok(!state.sentMessages.some((m) => m.type === 'UPDATE_RULES'), 'no background notification after a failed write');
  assert.ok(errorMessages(state).some((m) => m.includes('Error saving settings: Quota exceeded')));
});

test('flashes an error when chrome.storage.local.set throws synchronously', async () => {
  const state = await bootPopup({ storageSetThrow: true });
  state.el.searchUrl.value = VALID_URL;
  state.el.save.click();

  assert.equal(state.el.save.textContent, 'Error!');
  assert.equal(state.el.save.disabled, false);
  assert.equal(state.storage.customSearchUrl, undefined);
  assert.ok(!state.sentMessages.some((m) => m.type === 'UPDATE_RULES'));
  assert.ok(errorMessages(state).some((m) => m.includes('Error saving settings: storage.local.set exploded')));
});

test('aborts the save with an error flash when the URL fails validation', async () => {
  const state = await bootPopup();
  state.el.searchUrl.value = 'https://example.com/search'; // missing %s
  state.el.save.click();

  assert.equal(state.el.save.textContent, 'Error!');
  assert.equal(state.storage.customSearchUrl, undefined, 'nothing is written for an invalid URL');
  assert.ok(!state.sentMessages.some((m) => m.type === 'UPDATE_RULES'));
  assert.ok(errorMessages(state).some((m) => m.includes('Save aborted: URL must include %s in place of your query')));
  assert.equal(state.el.urlCheckStatus.textContent, 'URL must include %s in place of your query');
  assert.equal(state.el.urlCheckStatus.className, 'validation-status invalid');
  assert.equal(state.el.searchUrl.getAttribute('aria-invalid'), 'true');
});

test('resets the save button label and flash class after the feedback window', async () => {
  const state = await bootPopup();
  state.el.searchUrl.value = VALID_URL;
  state.el.enableExtension.checked = true;
  state.el.save.click();
  assert.equal(state.el.save.textContent, 'Saved!');

  state.tick(1200);
  assert.equal(state.el.save.textContent, 'Save Options');
  assert.ok(!state.el.save.classList.contains('success-flash'));
});

test('saves from Enter in the URL input (keydown binding)', async () => {
  // Regression guard for the keypress → keydown fix: dispatching keypress
  // would not reach the handler, so this only passes while the listener is
  // bound to keydown.
  const state = await bootPopup();
  state.el.searchUrl.value = VALID_URL;
  state.el.enableExtension.checked = true;
  const event = state.el.searchUrl.dispatchEvent('keydown', { key: 'Enter' });

  assert.equal(event.defaultPrevented, true);
  assert.equal(state.storage.customSearchUrl, VALID_URL);
  assert.equal(state.el.save.textContent, 'Saved!');
});

test('saves from the Ctrl+S keyboard shortcut', async () => {
  const state = await bootPopup();
  state.el.searchUrl.value = VALID_URL;
  state.el.enableExtension.checked = true;
  const event = state.fireDocument('keydown', { key: 's', ctrlKey: true });

  assert.equal(event.defaultPrevented, true);
  assert.equal(state.storage.customSearchUrl, VALID_URL);
  assert.equal(state.storage.extensionEnabled, true);
});

test('saves from the Cmd+S (meta) variant too', async () => {
  const state = await bootPopup();
  state.el.searchUrl.value = VALID_URL;
  state.fireDocument('keydown', { key: 's', metaKey: true });
  assert.equal(state.storage.customSearchUrl, VALID_URL);
});
