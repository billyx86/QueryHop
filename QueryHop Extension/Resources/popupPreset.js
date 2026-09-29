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
// popup.js composes it: it builds the context, calls createPresetController
// once, and delegates updateButtonText / wireEvents / resetDropdown to the
// returned controller.

import {
  DEFAULT_PRESET_BUTTON_TEXT,
  presetLabelForUrl,
  presetCloseOnOutsideClick,
} from './popupState.js';

export function createPresetController(ctx) {
  const { elements, t, logInfo, performUrlCheck } = ctx;

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
            logInfo(`Preset applied: ${buttonTarget.textContent.trim()}`);
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
          const currentItem = document.activeElement;
          if (currentItem && currentItem.classList.contains('preset-item')) {
            const nextItem = currentItem.nextElementSibling;
            if (nextItem) nextItem.focus();
          }
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          const currentItem = document.activeElement;
          if (currentItem && currentItem.classList.contains('preset-item')) {
            const prevItem = currentItem.previousElementSibling;
            if (prevItem) {
              prevItem.focus();
            } else {
              toggleDropdown(false);
              elements.presetToggleBtn?.focus();
            }
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
  }

  return { updateButtonText, toggleDropdown, wireEvents, resetDropdown };
}
