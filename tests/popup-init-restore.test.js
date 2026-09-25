// Boot / restore / preset-picker coverage for the REAL popup.js (issue #38).
// Drives the actual DOMContentLoaded initialization, chrome.storage restore,
// the preset dropdown interactions and the i18n fallback path against the
// fake browser environment in tests/popup-harness.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootPopup, flush, logMessages, errorMessages } from './popup-harness.js';

const KAGI_URL = 'https://kagi.com/search?q=%s';

test('boots with defaults: empty URL, unchecked boxes, empty debug log', async () => {
  const state = await bootPopup();

  assert.equal(state.el.searchUrl.value, '');
  assert.equal(state.el.unsafeMode.checked, false);
  assert.equal(state.el.enableExtension.checked, false);
  assert.equal(state.el.debugLog.checked, false);
  assert.equal(state.el.unsafeWarning.style.display, 'none');
  assert.equal(state.el.unsafeWarning.getAttribute('role'), null);
  assert.equal(state.el.debugLogView.textContent, 'Debug log is empty.');
  assert.equal(state.el.urlCheckStatus.textContent, 'Leaving the URL empty will disable redirection');
  assert.equal(state.el.urlCheckStatus.className, 'validation-status info-empty');
  assert.equal(state.el.presetToggleText.textContent, 'Select Preset');
  assert.equal(state.document.activeElement, state.el.searchUrl, 'focus lands on the URL input');
  assert.ok(logMessages(state).some((p) => p.message === 'Popup initialized successfully.'));
});

test('restores stored settings into the form and runs the URL check', async () => {
  const state = await bootPopup({
    storage: {
      customSearchUrl: KAGI_URL,
      allowUnsafeMode: true,
      extensionEnabled: true,
      debugLogEnabled: true,
    },
  });

  assert.equal(state.el.searchUrl.value, KAGI_URL);
  assert.equal(state.el.unsafeMode.checked, true);
  assert.equal(state.el.enableExtension.checked, true);
  assert.equal(state.el.debugLog.checked, true);
  assert.equal(state.el.unsafeWarning.style.display, 'block');
  assert.equal(state.el.unsafeWarning.getAttribute('role'), 'alert');
  // Unsafe mode is restored → validation is bypassed (info-bypass), not run.
  assert.equal(state.el.urlCheckStatus.textContent, 'URL validation is disabled');
  assert.equal(state.el.urlCheckStatus.className, 'validation-status info-bypass');
  assert.equal(state.el.searchUrl.getAttribute('aria-invalid'), null, 'a bypassed URL carries no aria-invalid');
  assert.equal(state.el.presetToggleText.textContent, 'Kagi', 'the stored URL matches a preset → its name');
});

test('storage failure on boot falls back to defaults and logs an error', async () => {
  const state = await bootPopup({ storageGetError: 'The session has ended' });

  assert.equal(state.el.searchUrl.value, '');
  assert.equal(state.el.unsafeMode.checked, false);
  assert.equal(state.el.enableExtension.checked, false);
  assert.equal(state.el.debugLog.checked, false);
  // resetToDefaults() clears the check status entirely (no URL check runs).
  assert.equal(state.el.urlCheckStatus.textContent, '');
  assert.equal(state.el.presetToggleText.textContent, 'Select Preset');
  assert.ok(errorMessages(state).some((m) => m.includes('[storage_error] Error loading settings: The session has ended')));
  assert.ok(logMessages(state).some((p) => p.message === 'Error loading settings shown via console/log.'));
  assert.ok(!state.body.innerHTML.includes('Could not initialize'), 'a storage failure is not an init failure');
});

test('missing essential elements replace the body with the init-failure message', async () => {
  const state = await bootPopup({ omitElements: ['save'] });

  assert.equal(state.el.save, undefined);
  assert.ok(state.body.innerHTML.includes('Error: Could not initialize popup UI.'));
  assert.ok(errorMessages(state).some((m) => m.includes('[dom_error] Initialization failed: One or more essential UI elements are missing.')));
});

test('localizes static markup when chrome.i18n provides messages', async () => {
  const state = await bootPopup({
    i18nMessages: {
      save_options: 'Speichern',
      select_preset: 'Vorlage wählen',
      custom_url_placeholder: 'z. B. https://…',
      custom_url_hint: 'Der Platzhalter <code>%s</code> wird durch die Suche ersetzt.',
    },
  });

  assert.equal(state.el.save.textContent, 'Speichern');
  assert.equal(state.el.presetToggleText.textContent, 'Vorlage wählen');
  assert.equal(state.el.searchUrl.getAttribute('placeholder'), 'z. B. https://…');
  assert.equal(state.el.urlHint.innerHTML, 'Der Platzhalter <code>%s</code> wird durch die Suche ersetzt.');
});

test('preserves English fallbacks when chrome.i18n has no messages', async () => {
  const state = await bootPopup(); // no i18nMessages → t() falls back to literals

  assert.equal(state.el.save.textContent, 'Save Options');
  assert.equal(state.el.presetToggleText.textContent, 'Select Preset');
  assert.equal(state.el.searchUrl.getAttribute('placeholder'), 'e.g. https://duckduckgo.com/?q=%s');
});

test('toggling unsafe mode shows and hides the warning with ARIA live', async () => {
  const state = await bootPopup();

  state.el.unsafeMode.checked = true;
  state.el.unsafeMode.dispatchEvent('change');
  assert.equal(state.el.unsafeWarning.style.display, 'block');
  assert.equal(state.el.unsafeWarning.getAttribute('role'), 'alert');
  assert.equal(state.el.unsafeWarning.getAttribute('aria-live'), 'polite');

  state.el.unsafeMode.checked = false;
  state.el.unsafeMode.dispatchEvent('change');
  assert.equal(state.el.unsafeWarning.style.display, 'none');
  assert.equal(state.el.unsafeWarning.getAttribute('role'), null);
  assert.equal(state.el.unsafeWarning.getAttribute('aria-live'), null);
});

test('typing in the URL input re-checks after the 300ms debounce', async () => {
  const state = await bootPopup();

  state.el.searchUrl.value = 'https://example.com/no-placeholder';
  state.el.searchUrl.dispatchEvent('input');
  // Before the debounce fires the status still shows the boot-time result.
  assert.equal(state.el.urlCheckStatus.textContent, 'Leaving the URL empty will disable redirection');

  state.tick(300);
  assert.equal(state.el.urlCheckStatus.textContent, 'URL must include %s in place of your query');
  assert.equal(state.el.urlCheckStatus.className, 'validation-status invalid');
  assert.equal(state.el.searchUrl.getAttribute('aria-invalid'), 'true');
  assert.equal(state.el.searchUrl.getAttribute('aria-errormessage'), 'urlCheckStatus');
});

test('the preset dropdown opens on click and focuses the first preset', async () => {
  const state = await bootPopup();
  assert.equal(state.el.presetDropdown.style.display, 'none');

  state.el.presetToggleBtn.click();
  assert.equal(state.el.presetDropdown.style.display, 'block');
  assert.equal(state.el.presetToggleBtn.getAttribute('aria-expanded'), 'true');

  state.tick(50); // the 50ms focus delay
  const items = state.presetItems();
  assert.equal(state.document.activeElement, items[0]);
});

test('opening the preset dropdown via Enter on the toggle works too', async () => {
  const state = await bootPopup();
  const event = state.el.presetToggleBtn.dispatchEvent('keydown', { key: 'Enter' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(state.el.presetDropdown.style.display, 'block');
});

test('clicking a preset applies its URL, closes the dropdown and refocuses the input', async () => {
  const state = await bootPopup();
  state.el.presetToggleBtn.click();
  const items = state.presetItems();

  items[1].click(); // the second preset (Brave)
  assert.equal(state.el.searchUrl.value, 'https://search.brave.com/search?q=%s');
  assert.equal(state.el.urlCheckStatus.textContent, 'URL format valid');
  assert.equal(state.el.presetDropdown.style.display, 'none');
  assert.equal(state.document.activeElement, state.el.searchUrl);
});

test('Escape closes the open dropdown and returns focus to the toggle', async () => {
  const state = await bootPopup();
  state.el.presetToggleBtn.click();
  assert.equal(state.el.presetDropdown.style.display, 'block');

  state.fireDocument('keydown', { key: 'Escape' });
  assert.equal(state.el.presetDropdown.style.display, 'none');
  assert.equal(state.document.activeElement, state.el.presetToggleBtn);
});

test('ArrowDown/ArrowUp move focus between presets; ArrowUp on the first closes', async () => {
  const state = await bootPopup();
  state.el.presetToggleBtn.click();
  state.tick(50);
  const items = state.presetItems();
  assert.equal(state.document.activeElement, items[0]);

  state.el.presetDropdown.dispatchEvent('keydown', { key: 'ArrowDown' });
  assert.equal(state.document.activeElement, items[1]);

  state.el.presetDropdown.dispatchEvent('keydown', { key: 'ArrowUp' });
  assert.equal(state.document.activeElement, items[0]);

  state.el.presetDropdown.dispatchEvent('keydown', { key: 'ArrowUp' }); // already first
  assert.equal(state.el.presetDropdown.style.display, 'none');
  assert.equal(state.document.activeElement, state.el.presetToggleBtn);
});

test('Enter in the dropdown activates the focused preset', async () => {
  const state = await bootPopup();
  state.el.presetToggleBtn.click();
  state.tick(50);

  const event = state.el.presetDropdown.dispatchEvent('keydown', { key: 'Enter' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(state.el.searchUrl.value, KAGI_URL); // first preset (Kagi) activated
  assert.equal(state.el.presetDropdown.style.display, 'none');
});

test('an outside click closes the open dropdown; inside clicks do not', async () => {
  const state = await bootPopup();
  state.el.presetToggleBtn.click();
  assert.equal(state.el.presetDropdown.style.display, 'block');

  state.fireDocument('click', { target: state.el.presetToggleBtn }); // inside the toggle
  assert.equal(state.el.presetDropdown.style.display, 'block');

  state.fireDocument('click', { target: state.presetItems()[0] }); // inside the dropdown
  assert.equal(state.el.presetDropdown.style.display, 'block');

  state.fireDocument('click', { target: state.el.searchUrl }); // outside
  assert.equal(state.el.presetDropdown.style.display, 'none');
});

test('the advanced options section toggles with ARIA expanded state', async () => {
  const state = await bootPopup();
  assert.equal(state.el.advancedOptions.style.display, 'none');

  state.el.toggleAdvanced.click();
  assert.equal(state.el.advancedOptions.style.display, 'block');
  assert.equal(state.el.toggleAdvanced.getAttribute('aria-expanded'), 'true');

  state.el.toggleAdvanced.click();
  assert.equal(state.el.advancedOptions.style.display, 'none');
  assert.equal(state.el.toggleAdvanced.getAttribute('aria-expanded'), 'false');
});

test('a failed GET_DEBUG_LOG on boot shows the load-failed message', async () => {
  const state = await bootPopup({ debugLogResponse: 'error' });
  assert.equal(state.el.debugLogView.textContent, 'Could not load the debug log.');
});

test('the refresh button re-reads the debug log from the background', async () => {
  const state = await bootPopup();
  assert.equal(state.el.debugLogView.textContent, 'Debug log is empty.');

  state.queueDebugLogResponse({
    success: true,
    entries: [
      { event: 'redirect', engine: 'kagi', query: 'n=6,fp=x', targetUrl: KAGI_URL, time: '2026-09-25T10:00:00.000Z' },
    ],
    entriesDropped: 0,
    maxEntries: 200,
  });
  state.el.refreshDebugLog.click();
  await flush();

  assert.equal(
    state.el.debugLogView.textContent,
    `[2026-09-25 10:00:00.000 UTC] kagi: n=6,fp=x → ${KAGI_URL}`
  );
});
