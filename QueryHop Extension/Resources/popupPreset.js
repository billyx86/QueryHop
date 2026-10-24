//
//  popupPreset.js
//  QueryHop Extension
//
// The preset picker for the options popup — split out of popup.js in #53.
// Owns the dropdown's open/close state, applying a preset to the URL field,
// keyboard navigation (Enter/Space/Arrow/Escape) and the outside-click /
// global-Escape close. It is a factory over a shared context so the pure
// state decisions (presetLabelForUrl, presetCloseOnOutsideClick in
// popupState.js) stay unit-tested there while this module keeps only the
// DOM wiring that needs the live elements and the i18n translator.
//
// User-managed presets (issue #126): the same controller renders the
// user's own presets — persisted in chrome.storage.local under
// USER_PRESETS_KEY, independent of the Save Options flow — below the
// built-ins, and wires the add / rename / delete controls. The CRUD
// decisions themselves are pure and unit-tested in popupState.js.
//
// popup.js composes it: it builds the context, calls createPresetController
// once, and delegates updateButtonText / wireEvents / resetDropdown /
// restoreUserPresets to the returned controller.

import {
  DEFAULT_PRESET_BUTTON_TEXT,
  presetLabelForUrl,
  presetCloseOnOutsideClick,
  USER_PRESETS_KEY,
  addUserPreset,
  renameUserPreset,
  deleteUserPreset,
  normalizeUserPresets,
} from './popupState.js';

export function createPresetController(ctx) {
  const { elements, t, logInfo, performUrlCheck, localizedValidationMessage } = ctx;

  // The user's own presets: an in-memory mirror of chrome.storage.local's
  // USER_PRESETS_KEY. Every mutation goes through the pure CRUD helpers in
  // popupState.js and is persisted immediately, so presets survive an
  // extension restart whether or not the user then presses Save Options.
  let userPresets = [];

  function updateButtonText(currentUrl) {
    if (!elements.presetToggleText || !elements.presetDropdown) return;

    // The label decision (match by data-url, default-text fallback) is
    // pure and unit-tested in popupState.js; this is just DOM wiring.
    const presets = [...elements.presetDropdown.querySelectorAll('.preset-item')].map((item) => ({
      url: item.dataset.url || '',
      name: (item.querySelector('.preset-name')?.textContent || '').trim(),
    }));
    const label = presetLabelForUrl(presets, currentUrl);
    // Preset names are product names (not translated); only the
    // "no preset matches" default text is localized.
    elements.presetToggleText.textContent =
      label === DEFAULT_PRESET_BUTTON_TEXT ? t('select_preset', label) : label;
  }

  // --- User-managed presets (issue #126) -----------------------------------

  function persistUserPresets() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.set({ [USER_PRESETS_KEY]: userPresets }, () => {
      if (chrome.runtime && chrome.runtime.lastError) {
        logInfo(`Warning: could not persist user presets: ${chrome.runtime.lastError.message}`);
      }
    });
  }

  // Build one dropdown row for a user preset. The row itself applies the
  // preset on click (same contract as the built-in items — the dropdown's
  // click handler reads .preset-item[data-url]); the rename / delete action
  // buttons stopPropagation so their clicks are never interpreted as "apply
  // this preset".
  function makeUserRow(preset, index) {
    const row = document.createElement('div');
    row.className = 'preset-item preset-item-user';
    row.setAttribute('role', 'option');
    row.setAttribute('tabindex', '0');
    row.dataset.url = preset.url;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'preset-name';
    nameSpan.textContent = preset.name;
    row.appendChild(nameSpan);

    const renameBtn = document.createElement('button');
    renameBtn.className = 'preset-row-action preset-rename';
    renameBtn.type = 'button';
    renameBtn.setAttribute('title', t('preset_rename', 'Rename'));
    renameBtn.setAttribute('aria-label', t('preset_rename', 'Rename'));
    renameBtn.textContent = '✎';
    renameBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      startRename(row, index);
    });
    row.appendChild(renameBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'preset-row-action preset-delete';
    deleteBtn.type = 'button';
    deleteBtn.setAttribute('title', t('preset_delete', 'Delete'));
    deleteBtn.setAttribute('aria-label', t('preset_delete', 'Delete'));
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const result = deleteUserPreset(userPresets, index);
      if (!result.ok) {
        logInfo(`Warning: preset delete failed (${result.error}).`);
        return;
      }
      userPresets = result.presets;
      persistUserPresets();
      renderUserRows();
      updateButtonText(elements.urlInput ? elements.urlInput.value : '');
      logInfo(`Preset deleted: ${preset.name}`);
    });
    row.appendChild(deleteBtn);

    return row;
  }

  // Re-render the user-preset rows from the in-memory list. Called after the
  // boot restore and after every add / rename / delete.
  function renderUserRows() {
    const list = elements.presetUserList;
    const section = elements.presetUserSection;
    if (!list || !section) return;
    for (const child of [...list.children]) list.removeChild(child);
    userPresets.forEach((preset, index) => list.appendChild(makeUserRow(preset, index)));
    section.style.display = userPresets.length ? 'block' : 'none';
  }

  // Swap the row's name span for an edit input. Enter commits through the
  // pure renameUserPreset() (blank names are refused), Escape cancels; both
  // re-render the rows, and stopPropagation keeps the dropdown's own Enter
  // handler from firing on the edit input.
  function startRename(row, index) {
    const current = userPresets[index];
    if (!current) return;
    const nameSpan = row.querySelector('.preset-name');
    if (!nameSpan) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'preset-rename-input';
    input.maxLength = 40;
    input.value = current.name;

    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      if (commit) {
        const result = renameUserPreset(userPresets, index, input.value);
        if (!result.ok) {
          logInfo(`Warning: preset rename failed (${result.error}).`);
          renderUserRows();
          return;
        }
        userPresets = result.presets;
        persistUserPresets();
        logInfo(`Preset renamed: ${result.presets[index].name}`);
      }
      renderUserRows();
      updateButtonText(elements.urlInput ? elements.urlInput.value : '');
    };

    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });

    const parent = nameSpan.parentNode;
    if (!parent) return;
    // The test harness's FakeElement has no replaceChild/insertBefore, so
    // remove + append, and let CSS (order: -1) keep the input in the name
    // slot of the flex row in the real DOM.
    parent.removeChild(nameSpan);
    row.appendChild(input);
    input.focus();
  }

  // --- Add-preset form ------------------------------------------------------

  function clearAddStatus() {
    const status = elements.presetAddStatus;
    if (!status) return;
    status.className = 'validation-status';
    status.textContent = '';
  }

  function showAddStatus(message) {
    const status = elements.presetAddStatus;
    if (!status) return;
    status.className = 'validation-status invalid';
    status.textContent = message;
  }

  // Map an addUserPreset() failure to user-facing text. The form-specific
  // failures (blank name / blank URL / duplicate) have keys of their own;
  // URL validation failures carry the validator's English message, so they
  // are routed through the same localizedValidationMessage() the main URL
  // field uses — one message, one locale key, no second switch to drift.
  function addErrorMessage(error) {
    if (error === 'missing-name') return t('preset_name_required', 'Preset name cannot be empty');
    if (error === 'empty-url') return t('preset_url_required', 'Preset URL cannot be empty');
    if (error === 'duplicate') return t('preset_duplicate_url', 'That URL is already in your presets');
    return localizedValidationMessage(error);
  }

  function openAddForm() {
    const form = elements.presetAddForm;
    if (!form || !elements.presetAddName || !elements.presetAddUrl) return;
    elements.presetAddName.value = '';
    elements.presetAddUrl.value = elements.urlInput ? elements.urlInput.value : '';
    clearAddStatus();
    form.style.display = 'block';
    elements.presetAddName.focus();
  }

  function closeAddForm() {
    const form = elements.presetAddForm;
    if (!form) return;
    form.style.display = 'none';
    clearAddStatus();
  }

  function submitAddPreset() {
    const nameInput = elements.presetAddName;
    const urlInput = elements.presetAddUrl;
    if (!nameInput || !urlInput) return;
    // The URL is routed through the same validation as the custom URL field,
    // honouring the "Disable URL Validation" checkbox (issue #126).
    const unsafeChecked = elements.unsafeModeCheckbox ? elements.unsafeModeCheckbox.checked : false;
    const result = addUserPreset(userPresets, nameInput.value, urlInput.value, { allowUnsafe: unsafeChecked });
    if (!result.ok) {
      showAddStatus(addErrorMessage(result.error));
      return;
    }
    userPresets = result.presets;
    persistUserPresets();
    renderUserRows();
    closeAddForm();
    updateButtonText(elements.urlInput ? elements.urlInput.value : '');
    logInfo(`Preset added: ${nameInput.value.trim()}`);
  }

  // --- Boot restore ---------------------------------------------------------

  // Read the stored user presets and render them. popup.js calls this before
  // the main restore flow; the callback re-syncs the toggle-button label
  // because the restored URL may match one of the user's presets.
  function restoreUserPresets() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get({ [USER_PRESETS_KEY]: [] }, (items) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        logInfo(`Warning: could not read user presets: ${chrome.runtime.lastError.message}`);
        return;
      }
      userPresets = normalizeUserPresets(items ? items[USER_PRESETS_KEY] : undefined);
      renderUserRows();
      updateButtonText(elements.urlInput ? elements.urlInput.value : '');
    });
  }

  function toggleDropdown(show) {
    if (!elements.presetDropdown || !elements.presetToggleBtn) return;

    const shouldShow = typeof show === 'boolean'
      ? show
      : elements.presetDropdown.style.display === 'none';

    if (shouldShow) {
      elements.presetDropdown.style.display = 'block';
      elements.presetToggleBtn.setAttribute('aria-expanded', 'true');

      const firstPreset = elements.presetDropdown.querySelector('.preset-item');
      if (firstPreset) {
        setTimeout(() => firstPreset.focus(), 50);
      }
    } else {
      elements.presetDropdown.style.display = 'none';
      elements.presetToggleBtn.setAttribute('aria-expanded', 'false');
    }
  }

  // Hide the dropdown and drop the toggle's expanded state — the reset
  // path only, mirroring the two independent null-guards the monolith had.
  function resetDropdown() {
    if (elements.presetDropdown) elements.presetDropdown.style.display = 'none';
    if (elements.presetToggleBtn) elements.presetToggleBtn.setAttribute('aria-expanded', 'false');
  }

  function wireEvents() {
    if (elements.presetToggleBtn) {
      elements.presetToggleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleDropdown();
      });

      elements.presetToggleBtn.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
          event.preventDefault();
          toggleDropdown(true);
        }
      });
    } else {
      logInfo('Warning: Preset toggle button not found.');
    }

    if (elements.presetDropdown) {
      elements.presetDropdown.addEventListener('click', (event) => {
        const buttonTarget = event.target.closest('.preset-item');
        if (buttonTarget && buttonTarget.dataset.url) {
          const presetUrl = buttonTarget.dataset.url;
          if (elements.urlInput) {
            elements.urlInput.value = presetUrl;
            // User rows carry action buttons inside (#126), so log the name
            // slot, not the row's full text.
            const label = (buttonTarget.querySelector('.preset-name')?.textContent
              || buttonTarget.textContent || '').trim();
            logInfo(`Preset applied: ${label}`);
            performUrlCheck();
            updateButtonText(presetUrl);
            toggleDropdown(false);
            elements.urlInput.focus();
          }
        }
      });

      elements.presetDropdown.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          toggleDropdown(false);
          elements.presetToggleBtn?.focus();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          // Index-based over the flat item list (#126): the user-preset
          // rows sit inside a nested section, so nextElementSibling alone
          // would not reach them.
          const items = elements.presetDropdown.querySelectorAll('.preset-item');
          const idx = items.indexOf(document.activeElement);
          if (idx !== -1) {
            const next = items[idx + 1];
            if (next) next.focus();
          }
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          const items = elements.presetDropdown.querySelectorAll('.preset-item');
          const idx = items.indexOf(document.activeElement);
          if (idx > 0) {
            items[idx - 1].focus();
          } else if (idx === 0) {
            toggleDropdown(false);
            elements.presetToggleBtn?.focus();
          }
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          document.activeElement.click();
        }
      });
    } else {
      logInfo('Warning: Preset dropdown container not found.');
    }

    document.addEventListener('click', (event) => {
      if (elements.presetDropdown) {
        // The close decision is pure and unit-tested in popupState.js.
        if (presetCloseOnOutsideClick({
          open: elements.presetDropdown.style.display === 'block',
          dropdown: elements.presetDropdown,
          toggleButton: elements.presetToggleBtn,
          target: event.target,
        })) {
          toggleDropdown(false);
        }
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (elements.presetDropdown && elements.presetDropdown.style.display === 'block') {
          toggleDropdown(false);
          elements.presetToggleBtn?.focus();
        }
      }
    });

    // Add-preset form controls (#126). The form sits NEXT to the dropdown
    // (a sibling), so without these stopPropagation calls the document
    // outside-click handler would close the open dropdown the moment the
    // user clicks a form field mid-edit. The form-level listener covers the
    // inputs and labels; the button listeners additionally route to the
    // controller callbacks.
    if (elements.presetAddForm) {
      elements.presetAddForm.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    }
    if (elements.presetAddBtn) {
      elements.presetAddBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        openAddForm();
      });
    }
    if (elements.presetAddSave) {
      elements.presetAddSave.addEventListener('click', (event) => {
        event.stopPropagation();
        submitAddPreset();
      });
    }
    if (elements.presetAddCancel) {
      elements.presetAddCancel.addEventListener('click', (event) => {
        event.stopPropagation();
        closeAddForm();
        if (elements.presetAddBtn) elements.presetAddBtn.focus();
      });
    }
  }

  return { updateButtonText, toggleDropdown, wireEvents, resetDropdown, restoreUserPresets };
}
