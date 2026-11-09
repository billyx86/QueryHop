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
  USER_PRESET_LIMIT,
  addUserPreset,
  renameUserPreset,
  deleteUserPreset,
  normalizeUserPresets,
  PRESET_EXPORT_FILENAME,
  serializeUserPresetsForExport,
  parsePresetImport,
  mergeImportedPresets,
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
    syncAriaSelected(currentUrl);
  }

  // aria-selected state for the ARIA listbox (issue #134): the option whose
  // data-url matches the current URL carries aria-selected="true", every
  // other option "false". updateButtonText() is the single choke point
  // every selection path flows through — a built-in or user preset applied
  // by click, by Enter/Space on the focused option, or by the URL field's
  // input (debounced) — so syncing here keeps the state correct for
  // keyboard nav (#133) and user rows (#126) alike, with no duplicated
  // bookkeeping at each call site.
  function syncAriaSelected(currentUrl) {
    if (!elements.presetDropdown) return;
    for (const item of elements.presetDropdown.querySelectorAll('.preset-item')) {
      item.setAttribute(
        'aria-selected',
        (item.dataset.url || '') === currentUrl ? 'true' : 'false',
      );
    }
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
  // Two-stage delete (issue #142): the ✕ sits 12 px from ✎ and the whole row
  // is clickable, so a misclick must not destroy the user's own preset data
  // on the first press. The first press ARMS the button (a localized "Sure?"
  // confirm state, disclosed on the aria-live manage status line) and the
  // second press within the window deletes. The arm is cancelled by a click
  // anywhere else (the document-level listener below) or when the window
  // elapses. Only one delete can be armed at a time.
  const DELETE_ARM_WINDOW_MS = 3000;
  let armedDelete = null; // { deleteBtn, preset, index, timerId }

  function disarmDelete() {
    if (!armedDelete) return;
    clearTimeout(armedDelete.timerId);
    const { deleteBtn } = armedDelete;
    deleteBtn.classList.remove('preset-delete-armed');
    deleteBtn.textContent = '✕';
    deleteBtn.setAttribute('title', t('preset_delete', 'Delete'));
    deleteBtn.setAttribute('aria-label', t('preset_delete', 'Delete'));
    armedDelete = null;
    clearManageStatus();
  }

  function deletePreset(preset, index) {
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
  }

  function armOrConfirmDelete(deleteBtn, preset, index) {
    const isArmed = armedDelete !== null && armedDelete.deleteBtn === deleteBtn;
    if (armedDelete) disarmDelete(); // clear this arm (or a stale one)
    if (isArmed) {
      deletePreset(preset, index);
    } else {
      deleteBtn.classList.add('preset-delete-armed');
      deleteBtn.textContent = t('preset_delete_confirm', 'Sure?');
      deleteBtn.setAttribute('title', t('preset_delete_confirm', 'Sure?'));
      deleteBtn.setAttribute('aria-label', t('preset_delete_confirm', 'Sure?'));
      armedDelete = {
        deleteBtn,
        preset,
        index,
        timerId: setTimeout(disarmDelete, DELETE_ARM_WINDOW_MS),
      };
      // The preset name is user data, not translatable: it is substituted
      // into the message. The fallback uses the repo's %s convention (what
      // the test harness runs); the locale files use Chrome's positional
      // $1 token (what the real chrome.i18n.getMessage runs), so both
      // paths name the preset.
      showManageStatus(
        'invalid',
        t('preset_delete_armed', 'Press again within a few seconds to delete “%s”.', preset.name)
      );
    }
  }

  function makeUserRow(preset, index) {
    const row = document.createElement('div');
    row.className = 'preset-item preset-item-user';
    row.setAttribute('role', 'option');
    row.setAttribute('tabindex', '0');
    // ARIA listbox contract (issue #134): a newly added preset is the
    // current URL, so the row starts selected; syncAriaSelected()
    // (updateButtonText) re-asserts it on every state change.
    row.setAttribute('aria-selected', 'true');
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
      armOrConfirmDelete(deleteBtn, preset, index);
    });
    row.appendChild(deleteBtn);

    // Keyboard path to the row actions (issue #140). The rename/delete
    // buttons are nested inside a role='option' div; the dropdown's
    // listbox keydown handler intercepts Enter/Space (which applies the
    // preset and closes the dropdown) and the arrows, so there is no default
    // keyboard route to the ✎/✕ — they were mouse-only. Dedicated keys, run
    // here while the ROW is focused: F2 (the universal rename key) opens
    // the rename editor, Delete/Backspace drives the two-stage delete.
    // These keys are not in the container handler's set, but we still stop
    // propagation so they stay local to the row. The rename input, when
    // open, has focus and its own handler stops propagation first, so
    // typing in the name field (incl. Backspace) never reaches this.
    row.addEventListener('keydown', (event) => {
      if (event.key === 'F2') {
        event.stopPropagation();
        event.preventDefault();
        startRename(row, index);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.stopPropagation();
        event.preventDefault();
        armOrConfirmDelete(deleteBtn, preset, index);
      }
    });

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
      if (commit) {
        const result = renameUserPreset(userPresets, index, input.value);
        if (!result.ok) {
          // Issue #141: don't silently discard a refused rename. Surface the
          // localized reason in the manage status line (aria-live) and keep
          // the input open with focus, so the name can be corrected and
          // retried. 'missing-name' is the only refusal the UI can reach
          // (the index always comes from the live render).
          logInfo(`Warning: preset rename failed (${result.error}).`);
          showManageStatus('invalid', t('preset_name_required', 'Preset name cannot be empty'));
          input.focus();
          return;
        }
        userPresets = result.presets;
        persistUserPresets();
        logInfo(`Preset renamed: ${result.presets[index].name}`);
      }
      settled = true;
      clearManageStatus();
      renderUserRows();
      updateButtonText(elements.urlInput ? elements.urlInput.value : '');
    };

    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      // Issue #138: while the input is live, EVERY keydown must stay local.
      // The listbox keydown handler (container-level) preventDefaults Space
      // (activates the focused option) and ArrowUp/Down (moves focus) — with
      // the edit input open those same keys must type a space and move the
      // caret, so stop propagation unconditionally. Enter/Escape are the two
      // keys the editor itself acts on, on top of the local delivery.
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
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
    if (error === 'limit-reached') {
      // The cap is user-facing copy with one number: $1 in the locales,
      // %s in the fallback (popupI18n.applySubstitutions fills it).
      return t('preset_limit_reached', 'The preset limit of %s has been reached. Delete a preset first.', USER_PRESET_LIMIT);
    }
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

  // --- Preset export / import (issue #135) ---------------------------------

  function showManageStatus(kind, message) {
    const status = elements.presetManageStatus;
    if (!status) return;
    status.className = `validation-status ${kind}`;
    status.textContent = message;
  }

  function clearManageStatus() {
    const status = elements.presetManageStatus;
    if (!status) return;
    status.className = 'validation-status';
    status.textContent = '';
  }

  // Serialize the in-memory user presets and download them as a .json file.
  // The anchor is appended to the document body and given a one-shot click
  // listener that stops propagation, so the programmatic click never reaches
  // the document-level outside-click handler (which would close the open
  // dropdown). stopPropagation() does not prevent the default download.
  function exportUserPresets() {
    clearManageStatus();
    if (userPresets.length === 0) {
      showManageStatus('invalid', t('preset_export_empty', 'Nothing to export yet. Add a preset first.'));
      return;
    }
    const blob = new Blob([serializeUserPresetsForExport(userPresets)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = PRESET_EXPORT_FILENAME;
    anchor.addEventListener('click', (event) => event.stopPropagation());
    document.body.appendChild(anchor);
    anchor.click();
    if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
    URL.revokeObjectURL(url);
    showManageStatus('valid', t('preset_export_done', 'Presets exported'));
    logInfo(`Preset list exported (${userPresets.length} presets).`);
  }

  // Read the chosen file and merge it into the in-memory presets. file.text()
  // is async — state is only touched after the promise settles. Every imported
  // URL is routed through validateSearchUrl() (inside mergeImportedPresets),
  // so a poisoned URL rejects the whole import, exactly as the add flow.
  function handleImportFile(file) {
    file.text().then((text) => {
      const parsed = parsePresetImport(text);
      if (!parsed.ok) {
        showManageStatus(
          'invalid',
          parsed.error === 'invalid-json'
            ? t('preset_import_invalid_json', 'That file is not valid JSON')
            : t('preset_import_not_a_list', 'That file does not contain a preset list'),
        );
        return;
      }
      const unsafeChecked = elements.unsafeModeCheckbox ? elements.unsafeModeCheckbox.checked : false;
      const merged = mergeImportedPresets(userPresets, parsed.presets, { allowUnsafe: unsafeChecked });
      if (!merged.ok) {
        // A rejected import names the offending preset (issue #144): the
        // surfaced entry plus the localized validation reason. $1/$2/$3 in
        // the locales, %s ×3 in the fallback (applySubstitutions fills them
        // left to right). Kept on one line so the i18n-consistency key
        // scanner still sees the call (it is a single-line regex).
        const reason = localizedValidationMessage(merged.error);
        showManageStatus('invalid', t('preset_import_failed', 'Could not import "%s" (%s) — %s', merged.entry.name, merged.entry.url, reason));
        return;
      }
      userPresets = merged.presets;
      persistUserPresets();
      renderUserRows();
      updateButtonText(elements.urlInput ? elements.urlInput.value : '');
      showManageStatus(
        merged.added === 0 ? 'info-bypass' : 'valid',
        merged.added === 0
          ? t('preset_import_all_skipped', 'Those presets are already in your list')
          // A success status carries the counts (issue #145): a partial
          // merge (added + skipped) must be visible at a glance — and when
          // normalization dropped incomplete entries, the drop count too
          // (issue #151): a hand-edited backup entry must not vanish
          // silently. $1/$2 in the locales, %s ×2 in the fallback; the
          // dropped variant adds $3 / %s. Kept on one line so the
          // i18n-consistency key scanner still sees the call.
          : parsed.dropped > 0
            ? t('preset_import_counts_dropped', 'Presets imported: %s added, %s skipped, %s dropped (missing name or URL)', merged.added, merged.skipped, parsed.dropped)
            : t('preset_import_counts', 'Presets imported: %s added, %s skipped', merged.added, merged.skipped),
      );
      logInfo(`Preset list imported (${merged.added} added, ${merged.skipped} skipped).`);
    }).catch(() => {
      showManageStatus('invalid', t('preset_import_read_failed', 'Could not read that file'));
    });
  }

  function onImportFileChange() {
    const input = elements.presetImportFile;
    const file = input && input.files ? input.files[0] : null;
    if (!file) return;
    clearManageStatus();
    // Reset the input so re-selecting the same file fires change again.
    input.value = '';
    handleImportFile(file);
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
          //
          // querySelectorAll returns a NodeList, and NodeLists have no
          // indexOf (#131: the arrow-key nav here used to call
          // items.indexOf(...) and threw a TypeError on the first keypress
          // in a real browser, while the harness — whose fake querySelectorAll
          // returned a plain Array — stayed green). Spread to an Array,
          // matching the updateButtonText() pattern above.
          const items = [...elements.presetDropdown.querySelectorAll('.preset-item')];
          const idx = items.indexOf(document.activeElement);
          if (idx !== -1) {
            const next = items[idx + 1];
            if (next) next.focus();
          }
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          // Same NodeList caveat as ArrowDown (#131) — spread before
          // indexOf.
          const items = [...elements.presetDropdown.querySelectorAll('.preset-item')];
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
      // Issue #142: a click that reaches the document is, by definition, NOT
      // on the armed delete button (its own handler stopPropagation()s), so
      // any armed delete is cancelled by a click elsewhere. This runs before
      // the close decision and is unconditional — the arm only exists while
      // the row is visible, but disarming is safe whenever.
      disarmDelete();
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
    // Issue #139: the main URL field saves on Enter (popupSave.js), so the
    // add form gets the same contract. The form is a <form> without a
    // submit button of its own, so the default submit behaviour is useless
    // here — route Enter in either field straight to submitAddPreset().
    for (const field of [elements.presetAddName, elements.presetAddUrl]) {
      if (!field) continue;
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          submitAddPreset();
        }
      });
    }
    if (elements.presetAddCancel) {
      elements.presetAddCancel.addEventListener('click', (event) => {
        event.stopPropagation();
        closeAddForm();
        if (elements.presetAddBtn) elements.presetAddBtn.focus();
      });
    }

    // Export / import controls (#135). The manage row and the hidden file
    // input sit INSIDE the dropdown, so the document outside-click handler
    // already ignores them — stopPropagation() is belt-and-braces, keeping
    // these clicks from ever reaching the document-level listeners, matching
    // the add-form pattern above.
    if (elements.presetExportBtn) {
      elements.presetExportBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        exportUserPresets();
      });
    }
    if (elements.presetImportBtn) {
      elements.presetImportBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (elements.presetImportFile) elements.presetImportFile.click();
      });
    }
    if (elements.presetImportFile) {
      elements.presetImportFile.addEventListener('change', onImportFileChange);
    }
  }

  return {
    updateButtonText,
    toggleDropdown,
    wireEvents,
    resetDropdown,
    restoreUserPresets,
    exportUserPresets,
    handleImportFile,
  };
}
