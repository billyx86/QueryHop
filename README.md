# QueryHop - Search Redirector

![Logo for QueryHop](QueryHop%20Extension/Resources/images/Icon-256.png)

A Safari extension that allows you to change your search engine to one outside of Safari's defaults, either through set presets or a supplied custom URL.

[![Download on the Mac App Store](repo-resources/Download_on_the_Mac_App_Store_Badge_US-UK_RGB_blk_092917.svg)](https://itunes.apple.com/WebObjects/MZStore.woa/wa/viewSoftware?id=6744203249)

## Table of Contents
- [Description](#description)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Presets](#presets)
- [Custom URLs](#custom-urls)
- [Advanced Options](#advanced-options)
- [Localization](#localization)
- [FAQ](#faq)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

## Description

QueryHop is a lightweight extension that intercepts searches from Safari's default search engines (Google, Bing, DuckDuckGo, Baidu, etc.) and redirects them to your preferred search engine. Unlike Safari's built-in search engine options, this extension works with any search engine that accepts query parameters.

Key features:
- Redirection from default search engines before they begin to load
- Integrated preset options for popular alternative search engines
- Custom URL configuration for any search engine
- Works with Safari on macOS (iOS/iPadOS support coming soon!)

## Requirements

- Safari 14.0 or later on macOS 11.5+

## Installation

### From GitHub (Free, Notarized)
1. Download the latest release from the [Releases page](https://github.com/billyx86/QueryHop/releases)
3. Double-click the `.app` file
4. In the confirmation dialog, click **Open**
5. When prompted, click **Quit and Open Safari Extensions Preferences…**
6. Enable the extension in the **Extensions** tab

I will always distribute this extension for free alongside the App Store build.

### From Mac App Store ($0.99)
> [!NOTE]  
> This method is for those who want automatic updates or wish to support the development of QueryHop. Your support is greatly appreciated!

You can download the app on the Mac App Store by either clicking the button on the top of the README or clicking [here](https://itunes.apple.com/WebObjects/MZStore.woa/wa/viewSoftware?id=6744203249).

## Usage

1. Install the extension and enable it in Safari's extensions preferences
2. Click on the extension's icon on the toolbar
3. You will have to allow the extension to access the website you are viewing and the search engine you'd like to redirect from (or all websites)*.
4. Either:
   - Select a preset search engine from the dropdown
   - Enter a custom URL with a `%s` placeholder for the search query
5. Click **Save Options**
6. Search using any supported search engine (Google, Bing, etc.), and you'll be automatically redirected to your chosen search engine

\* Unfortunately, there is no way I could find around this. 

This extension does not collect logs or data at all, but for peace of mind I recommend only allowing it for search engines you'd like to redirect from. Please refer to "**Is my search data private?**" under the [FAQs](#faq) for more information.

## Presets

The extension comes with several presets for popular alternative search engines:
- Ask.com
- Brave Search
- Kagi
- Lilo
- Mojeek
- Perplexity
- Presearch
- Qwant
- SearXNG (local instances hosted on port 8080)
- Startpage
- You.com

More presets can be added upon request, or alternatively, they can be found in the [`popup.html`](https://github.com/billyx86/QueryHop/blob/main/QueryHop%20Extension/Resources/popup.html) file if you would like to submit a pull request/fork the repository.

Each preset name is localised through its own `preset_name_*` key in `_locales/{en,de}/messages.json` (issue #35): the static text in `popup.html` is the English fallback, and `applyI18n()` replaces it with the current locale's value. Brand names are proper nouns and intentionally stay identical in both locales; the SearXNG entry's generic wording is translated. If you add a preset, add a `data-i18n` key to the `.preset-name` span and the matching entries to both locale files — `tests/preset-consistency.test.js` and `tests/i18n-consistency.test.js` fail the build if either side is missing.

## Custom URLs

To use a custom search engine, you need to provide its search URL with a `%s` placeholder where the search query should be inserted.

Example formats:
- `https://example.com/search?q=%s`
- `https://search.example.org/?query=%s&param=value`

The extension will replace `%s` with your search term, properly URL-encoded.

## Advanced Options

### Disable URL Validation

The extension includes a "Disable URL Validation" setting. This is useful for:
- Using non-standard URL schemes
- Omitting the `%s` placeholder (redirects to a static URL)
- Using internal browser URLs

**Warning:** Unsafe Mode can potentially lead to unsafe redirects. Use with caution.

### Debug Log

The "Record debug log" setting keeps a short, local trail of redirects in the
options page's **Recent activity** pane: which engine matched, whether
validation is disabled, and any blocked-scheme attempts.

- **Privacy:** search terms are never recorded — only a length plus a
  short, non-reversible fingerprint of each search, and credential-looking
  URL parameters are shown as `[REDACTED]`. The log lives only in the
  current browser session (it is cleared when the browser exits) and is
  never sent anywhere.
- **Copy log:** the **Copy log** button copies the *full* in-session log
  (not just the 50 lines shown in the pane) as plain text to the
  clipboard, for sharing in support requests or bug reports. The copied
  text carries the same redaction guarantees as the pane, and says so.
  If the log has overflowed the 200-entry buffer, the export (and the
  pane) appends a note stating how many older entries were dropped, so a
  shared log is never mistaken for the complete record.
- **Clear:** wipes the in-session log and its drop counter.

## Localization

Both the popup and the host window are fully localised into **English** and
**German** (issues #21, #26, #35), with a 1:1 parity of keys between the two
locales enforced in CI.

- **How the locale is chosen:** there is no in-app language switch — the
  locale follows the **Safari/system locale**. The popup resolves strings
  through `chrome.i18n.getMessage` against `_locales/<lang>/messages.json`
  (falling back to English if a key or the whole locale is missing, so the
  UI never blanks out), and the host window reads the `<html lang>`
  attribute of `Main.html` to pick its `MESSAGES` table in `Script.js`.
- **Adding a new locale:** add a complete `_locales/<lang>/messages.json`
  covering every key — `tests/i18n-consistency.test.js` fails the build if
  any key is missing or the locales drift apart. For the host window, add a
  matching `<lang>.lproj/Main.html` with the same state hooks.
- **Preset rule (issue #35):** every new preset must also add its
  `preset_name_*` key to both locale files, as documented in the
  [Presets](#presets) section.

## FAQ

### How does it work?

The extension monitors navigation events to popular search engines. When you submit a search on one of these engines, the extension captures the search query and redirects your browser to your preferred search engine with the same query.

### Does it work with all search engines?

The extension can redirect from the following search engines:
- Google
- Bing
- DuckDuckGo
- Yahoo
- Baidu
- Ecosia
- Yandex

It can redirect to any search engine that accepts query parameters.

### Is my search data private?

The extension processes all data locally and doesn't send any information about your searches to external servers. Your search queries are only shared with the search engine you've chosen to redirect to.

## Testing

The extension and host app have a self-contained unit test suite under
[`tests/`](tests). It uses Node.js's built-in test runner — no dependencies
to install — and requires Node 22 or newer.

```sh
npm test        # or: node --test
```

The suite is 242 tests across 14 files:

| Module | What it guards |
| --- | --- |
| [`background.test.js`](tests/background.test.js) | The redirect/validation core of `background.js`: `isBlockedScheme`, `validateUrl`, `createTargetUrl`, `extractSearchQuery`, `redirectTab`, `handleNavigation`, `getSettings` (issue #6) |
| [`popup-rules.test.js`](tests/popup-rules.test.js) | The popup's pure rules/formatting module [`popupRules.js`](QueryHop%20Extension/Resources/popupRules.js) — URL-validation results, blocked-scheme detection, and the debug-log line/copy formatting (issue #14) |
| [`popup-state.test.js`](tests/popup-state.test.js) | The pure save-flow / feedback / preset-picker state machine in [`popupState.js`](QueryHop%20Extension/Resources/popupState.js) (issue #22) |
| [`popup-save-flow.test.js`](tests/popup-save-flow.test.js) | The real `popup.js` save flow against a fake DOM/`chrome` environment ([`tests/popup-harness.js`](tests/popup-harness.js)): button/Enter/⌘S triggers, the in-flight `Saving…` state, the background-ack failure path (#37), storage errors, and the timed feedback reset (issue #38) |
| [`popup-init-restore.test.js`](tests/popup-init-restore.test.js) | The real `popup.js` boot path: settings restore, storage-failure fallback to defaults, missing-element init failure, i18n application, the preset picker (toggle, apply, keyboard nav, outside-click close) and the debug-log refresh (#38) |
| [`popup-debug-log.test.js`](tests/popup-debug-log.test.js) | The real `popup.js` debug-log flows: copy-to-clipboard with the `execCommand` fallback (#15), clear-log, the 50-entry view cap with truncation footer (#19) and clipboard-unavailable feedback (issue #38) |
| [`popup-i18n.test.js`](tests/popup-i18n.test.js) | The i18n helpers in [`popupI18n.js`](QueryHop%20Extension/Resources/popupI18n.js) — `makeT`, `applySubstitutions`, `applyI18n` (issue #21) |
| [`i18n-consistency.test.js`](tests/i18n-consistency.test.js) | Popup i18n wiring: `_locales/{en,de}/messages.json`, the `data-i18n*` markup in `popup.html`, and the dynamic strings in `popup.js` must stay in sync (issue #21) |
| [`host-window-i18n.test.js`](tests/host-window-i18n.test.js) | Host-window i18n: en/de parity of the `MESSAGES` table in `Script.js` and the `Main.html` locale files, the single-source-of-truth rule for the state copy (#29), and the a11y markers (#31) (issue #26) |
| [`manifest-consistency.test.js`](tests/manifest-consistency.test.js) | Engine URL patterns in `background.js` vs `host_permissions` in `manifest.json` (issue #9) |
| [`engine-permissions-sync.test.js`](tests/engine-permissions-sync.test.js) | Derives the expected engine hosts from `searchEngines` in `background.js` and checks the manifest — no hand-maintained engine list (issue #27) |
| [`engine-presets-consistency.test.js`](tests/engine-presets-consistency.test.js) | Pins `searchEngines` in `background.js` against the popup's preset list as ordered sets (issue #25) |
| [`preset-consistency.test.js`](tests/preset-consistency.test.js) | Every hardcoded preset in `popup.html` passes the popup's own URL validator, so a dropped `%s` or a changed vendor URL fails the build (issue #23) |
| [`blocked-schemes-consistency.test.js`](tests/blocked-schemes-consistency.test.js) | The `BLOCKED_SCHEMES` denylist in `background.js` and its copy in `popupRules.js` stay in sync (issue #18) |

CI runs the full suite on every push and pull request, and also
syntax-checks every extension and host-app script, validates the JSON
resources, guards against spaced/"Copy N" duplicate filenames (#40), and —
on macOS — builds the host app with Xcode, verifies the extension payload
actually ships inside the built `.appex`, and runs the native Swift test
target (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

### Swift unit tests (macOS only)

The native Swift side is covered by the `QueryHopTests` XCTest target under
[`QueryHopTests/`](QueryHopTests), sharing its bridge code with the app and
extension through [`Shared/HostBridge.swift`](Shared/HostBridge.swift):

| File | What it guards |
| --- | --- |
| [`HostWindowJSTests.swift`](QueryHopTests/HostWindowJSTests.swift) | The host-window bridge helpers in `Shared/HostBridge.swift`: the pinned `open-preferences` message literal and the JS string escaping / `show` / `showError` literals the host window evaluates (issue #41) |
| [`NativeMessageCodecTests.swift`](QueryHopTests/NativeMessageCodecTests.swift) | The `browser.runtime.sendNativeMessage` payload contract in `SafariWebExtensionHandler.beginRequest` — extraction, nil handling, and the echo response (issue #41) |
| [`HostWindowContractTests.swift`](QueryHopTests/HostWindowContractTests.swift) | Drift-guards the native↔host-window contract from the Swift side: the `MESSAGES` table in `Script.js`, the state hooks in the `Main.html` locale files, and the `open-preferences` message literal — what the JS suite cannot see (issue #41) |

The host app's `Resources` directory is bundled into the test bundle as a
`HostResources` folder reference, so the contract tests read the real
shipped files. Run them with `xcodebuild test -project QueryHop.xcodeproj
-scheme QueryHop` on macOS (CI does this automatically in the
`build-macos` job).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/additional-feature`)
3. Commit your changes (`git commit -m 'Add some awesome feature'`)
4. Push to the branch (`git push origin feature/additional-feature`)
5. Open a Pull Request

## License

This project is licensed under the GPLv3 License - see the LICENSE file for details.
