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
- [Releasing](#releasing)
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

The suite is 362 tests across 25 files:

| Module | What it guards |
| --- | --- |
| [`background.test.js`](tests/background.test.js) | The redirect/validation core of `background.js`: `isBlockedScheme`, `validateUrl`, `createTargetUrl`, `extractSearchQuery`, `redirectTab`, `handleNavigation`, `getSettings` and settings-cache invalidation (issues #6, #52), plus the `logMessage` level→console routing (issue #89) |
| [`popup-rules.test.js`](tests/popup-rules.test.js) | The popup's pure rules/formatting module [`popupRules.js`](QueryHop%20Extension/Resources/popupRules.js) — URL-validation results, blocked-scheme detection, and the debug-log line/copy formatting (issue #14) |
| [`popup-state.test.js`](tests/popup-state.test.js) | The pure save-flow / feedback / restore / preset-picker state machine in [`popupState.js`](QueryHop%20Extension/Resources/popupState.js) (issues #22, #64) |
| [`popup-save-flow.test.js`](tests/popup-save-flow.test.js) | The real `popup.js` save flow against a fake DOM/`chrome` environment ([`tests/popup-harness.js`](tests/popup-harness.js)): button/Enter/⌘S triggers, the in-flight `Saving…` state, the background-ack failure path (#37), storage errors, and the timed feedback reset (issue #38) |
| [`popup-init-restore.test.js`](tests/popup-init-restore.test.js) | The real `popup.js` boot path: settings restore, storage-failure fallback to defaults, missing-element init failure, i18n application, the preset picker (toggle, apply, keyboard nav, outside-click close — `popupPreset.js`) and the debug-log refresh (#38) |
| [`popup-debug-log.test.js`](tests/popup-debug-log.test.js) | The real debug-log flows (the `popupDebug.js` controller wired from `popup.js`): copy-to-clipboard with the `execCommand` fallback (#15), clear-log, the 50-entry view cap with truncation footer (#19) and clipboard-unavailable feedback (issue #38) |
| [`popup-i18n.test.js`](tests/popup-i18n.test.js) | The i18n helpers in [`popupI18n.js`](QueryHop%20Extension/Resources/popupI18n.js) — `makeT`, `applySubstitutions`, `applyI18n`, plus the `#64` mapping factories `makeLocalizedSaveLabel` / `makeLocalizedValidationMessage` and the `#46` `syncDocumentLanguage` a11y helper (issue #21) |
| [`i18n-consistency.test.js`](tests/i18n-consistency.test.js) | Popup i18n wiring: `_locales/{en,de}/messages.json`, the `data-i18n*` markup in `popup.html`, and the dynamic strings in the popup modules (`popup.js` + `popupCore.js` + `popupSave.js` + `popupRestore.js` + `popupPreset.js` + `popupDebug.js` + `popupI18n.js`) must stay in sync (issues #21, #64) |
| [`host-window-i18n.test.js`](tests/host-window-i18n.test.js) | Host-window i18n: en/de parity of the `MESSAGES` table in `Script.js` and the `Main.html` locale files, the single-source-of-truth rule for the state copy (#29), and the a11y markers (#31) (issue #26) |
| [`host-window-state.test.js`](tests/host-window-state.test.js) | Host-window behaviour: the real `Script.js` state machinery driven through `globalThis.QueryHopHost` against a fake `document`/`webkit` mirroring `Main.html` — `detectLocale()`/`t()` locale resolution with the English fallback, `setText()` class-scoped updates, `populateStateText()` copy + aria-label, `show()` state-class switching, `showError()` prefix/fallback/one-element formatting, and the open-preferences button wiring to the native bridge (issue #85) |
| [`manifest-consistency.test.js`](tests/manifest-consistency.test.js) | Engine URL patterns in `bgCommon.js` vs `host_permissions` in `manifest.json` (issue #9) |
| [`engine-permissions-sync.test.js`](tests/engine-permissions-sync.test.js) | Derives the expected engine hosts from `searchEngines` in `bgCommon.js` and checks the manifest — no hand-maintained engine list (issue #27) |
| [`engine-presets-consistency.test.js`](tests/engine-presets-consistency.test.js) | Pins `searchEngines` in `bgCommon.js` against the popup's preset list as ordered sets (issue #25) |
| [`preset-consistency.test.js`](tests/preset-consistency.test.js) | Every hardcoded preset in `popup.html` passes the popup's own URL validator, so a dropped `%s` or a changed vendor URL fails the build (issue #23) |
| [`blocked-schemes-consistency.test.js`](tests/blocked-schemes-consistency.test.js) | The `BLOCKED_SCHEMES` denylist in `bgCommon.js` and its copy in `popupRules.js` stay in sync (issue #18) |
| [`navigation-filter-consistency.test.js`](tests/navigation-filter-consistency.test.js) | The `onBeforeNavigate` listener in `background.js` is registered without the malformed `url` filter that used to be derived from the engine regex sources, and `handleNavigation()` still does the authoritative `searchEngines` regex match (issue #77) |
| [`safari-allowed-domains.test.js`](tests/safari-allowed-domains.test.js) | The Safari `Info.plist` `SFSafariWebsiteAccess` "Allowed Domains" list covers every canonical engine host derived from the real `searchEngines` regexes (no hard-coded list), keeps `Level: Some`, and declares the Safari web-extension point (issue #76) |
| [`import-graph.test.js`](tests/import-graph.test.js) | Import-graph resolution guard: every relative `import … from './x'` / `export … from './x'` specifier in the shipped scripts resolves to a real file, the manifest entry points exist, and every non-popup extension module is reachable from `background.js` (orphaned modules ship in the appex dead) — a stdlib-only complement to the per-file `node --check` syntax floor, catching the #59 class (renamed/removed module breaking the service worker at startup) on Linux instead of in the 30-minute macOS build (issue #81) |
| [`e2e-browser.test.js`](tests/e2e-browser.test.js) | Loads the unpacked MV3 extension in a real headless Chrome and drives the runtime path the unit tests can't reach — save a custom URL through the popup, navigate to a search URL, and assert the background redirects the tab and logs it; disabled → no redirect. Dependency-free (Node's built-in WebSocket over CDP). Runs in the dedicated `e2e-browser` CI job (`QHYOP_E2E_BROWSER=1`); self-skips to a pass where no working browser exists, keeping the suite count deterministic (issue #75) |
| [`test-count-consistency.test.js`](tests/test-count-consistency.test.js) | Recomputes the suite size and fails if this README table's "N tests across M files" count drifts (issue #48) |
| [`version-sync.test.js`](tests/version-sync.test.js) | `manifest.json` `"version"` (three-part semver), every `MARKETING_VERSION` in `project.pbxproj`, and the root `package.json` `"version"` all stay in sync (issues #49, #58) |
| [`release-checksum.test.js`](tests/release-checksum.test.js) | The SHA-256 sidecar logic in [`scripts/release-checksum.mjs`](scripts/release-checksum.mjs): line-format generation, the `shasum -c` / `sha256sum -c` round-trip, tamper detection, and missing-file handling (issue #69) |
| [`verify-signed-artifact.test.js`](tests/verify-signed-artifact.test.js) | The signing/notarisation decision logic in [`scripts/verify-signed-artifact.mjs`](scripts/verify-signed-artifact.mjs): `codesign -d -v --verbose=4` parsing, signature classification (Developer ID / ad-hoc / other / unsigned, including real captured output), and the per-mode gate expectations (issues #63, #68) |
| [`release-tag-hygiene.test.js`](tests/release-tag-hygiene.test.js) | The tag-classification core in [`scripts/check-release-tag-hygiene.mjs`](scripts/check-release-tag-hygiene.mjs): orphaned tags (not reachable from main) fail, the current version's tag predating the latest release workflow is flagged stale, historical tags are grandfathered, undecidable tags fail closed (issue #67) |
| [`e2e-full-tier-freshness.test.js`](tests/e2e-full-tier-freshness.test.js) | The decision core in [`scripts/check-e2e-full-tier-freshness.mjs`](scripts/check-e2e-full-tier-freshness.mjs): cron extraction from the workflow text, the run-completion timestamp, and the full freshness matrix — a fresh recent success, staleness past the 8-day limit, a non-success latest run (failure/cancel), an in-progress run, the zero-run grace window from workflow activation, branch isolation, and the manual `workflow_dispatch` exclusion (issues #83, #88) |

CI runs the full suite on every push and pull request, and also
syntax-checks every extension and host-app script, lints all JavaScript
against the repo's zero-dependency ESLint flat config
([`eslint.config.js`](eslint.config.js) — a correctness floor, not a style
police, run via `npx -y -p eslint@9.39.5` so no packages land in
`package.json`; the version is pinned exactly — issue #84, matching the
vitest pinning convention — so an upstream eslint release can never change
the gate's findings under a PR; issue #79), validates the JSON resources, guards
against spaced/"Copy N" duplicate filenames (#40), and — on macOS —
builds the host app with Xcode, verifies the extension payload actually
ships inside the built `.appex`, and runs the native Swift test target
(see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

The browser e2e net is tiered: when a runner image's headless Chrome does
not surface the MV3 service worker, it passes in DEGRADED mode instead of
failing on the environment (the right call for a PR gate). To keep that
honest, every run records the tier it actually achieved — an
`e2e-tier=full|degraded|skipped` log line plus a machine-readable
`e2e-tier.json` (gitignored byproduct; CI surfaces it in the step
summary) — and a weekly [`e2e-full-tier`](.github/workflows/e2e-full-tier.yml)
job (scheduled Sunday 06:00 UTC, or on demand via *Actions → Run
workflow*) re-runs the net on a runner with a full Chrome and **requires**
the full tier, so a runner image that degrades indefinitely cannot mask a
stale behavioral net forever (issue #80).

The gate in turn has a health tripwire of its own: `scripts/check-e2e-full-
tier-freshness.mjs` (wired into CI's validate job, with the gate health
surfaced in the e2e-browser step summary) fails any push if the weekly
workflow is missing or de-scheduled in the ref, if it has never fired past
its grace window (measured from the first commit that landed the workflow
on main), if its last successful run is older than 8 days, or if its latest
completed run is not a success — so a dead schedule or a silently failing
runner image cannot go unnoticed (issue #83).

### e2e full-tier gate — operator notes

The freshness tripwire cannot fail before the schedule has had a chance to
fire: staleness is measured from *workflow activation* (the first commit
that landed `.github/workflows/e2e-full-tier.yml` on `main`, read from git
history), and inside that window a push reports `grace` — the gate is
armed, not yet proven. The gate is fully armed once the first **scheduled**
run succeeds; from then on the 8-day limit applies. (A manual
`workflow_dispatch` run never arms it — issue #88.)

If a push fails on the tripwire, the verdict tells you which way to dig:

- `never-fired` / `stale` — the **schedule** is dead or silent: check that
  Actions is enabled for the repo, that the workflow is not paused, and
  that free-tier billing has not suspended schedules. The weekly slot is
  Sunday 06:00 UTC; a single missed Sunday is tolerated by the 8-day limit.
- `failing` — the schedule fired but the last scheduled run did not pass
  full: the usual cause is a runner-image environment change (exactly what
  the DEGRADED-tier tolerance exists for), not an app regression.

Recovery after a known-bad environment week: trigger the gate on demand
(*Actions → `e2e-full-tier` → Run workflow*) and watch it. A manual run is
a diagnostic lever, not schedule-liveness evidence, so re-running it does
not quiet a dead schedule — fix the schedule itself (repo settings,
billing, or a paused workflow) and let the next Sunday fire re-arm the
window. The tripwire can also be run at any time with
`node scripts/check-e2e-full-tier-freshness.mjs` (needs `gh` and a
`GH_TOKEN`; `--max-age-days N` tightens the limit).

Renaming or moving the workflow file fails loud rather than silent: the
CLI checks the file exists at its pinned path before anything else,
`activationDate` throws a clear error if that path has no commit history,
and the `extractCron` unit tests pin the regex against the real file
shape — so a rename is caught on the very first push, not after eight
days of silent staleness.

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

## Releasing

The version is written in **three places** and must be bumped in a single commit
(issues #49, #58):

1. `QueryHop Extension/Resources/manifest.json` — the `"version"` field
   (semver, three-part; the App Store review requires a version higher than
   the live listing).
2. `QueryHop.xcodeproj/project.pbxproj` — `MARKETING_VERSION` on all three
   targets (app + extension + test bundle). The extension's `Info.plist`
   uses build settings, so there is no separate plist version.
3. The root `package.json` — `"version"`. The npm scripts are dev-only, but
   a stale value leaks into every `npm test` log line (the suite reports
   `queryhop@<version>`), so it must not drift either.

A new version test will also keep the three in sync: bumping only one of the
three fails CI. To cut a release:

1. Bump all three places above in one commit (`chore: bump version to 1.0.3`).
2. Tag it with the `b` prefix the earlier releases used: `git tag b1.0.3`
   (tagged at the bump commit, not a feature branch).
3. Push the tag. The `release-macos.yml` workflow (issue #60) fires on any
   `b*` tag push: it builds the universal (arm64 + x86_64) app on a macOS
   runner, verifies the binary is really universal, and uploads
   `QueryHop-<version>-macos-universal-unsigned.zip` to the GitHub release
   (creating the release with placeholder notes if it does not exist yet).
   The asset is **unsigned** (ad-hoc at best) — the shared GitHub runners
   do not have the owner's Developer ID. A notarised
   `QueryHop-<version>-macos-universal.zip` is still built by hand on the
   owner's machine and uploaded on top; issue #60 tracks that pending
   notarised upload for release b1.0.2.

### Tag discipline (#67)

**Always cut release tags from `main`, never from a feature branch.**
GitHub Actions checks out the workflow file *from the ref being run*, so a
tag whose commit predates a workflow fix will re-run the **old** pipeline
if it is ever re-pushed (by a mirror, a fork, or an impatient maintainer).
`b1.0.2` sat in exactly that state — pointing at a pre-#65 commit — for
weeks.

Two invariants are enforced:

- `scripts/check-release-tag-hygiene.mjs` (wired into CI's validate job)
  fails the build if any `b*` tag points at a commit **not reachable from
  `origin/main`** (orphaned tag — unambiguous error). It also **warns**
  when the current version's tag (`b<manifest version>`) predates the
  latest change to `release-macos.yml` (stale tag — a normal transient
  state between a workflow change and the tag re-point, so not fatal).
- `scripts/check-release-drift.mjs` (also in CI) fails until a release
  exists for the manifest version, so the release can't drift 18 months
  behind main again (#54).

To fix a stale tag (run `--strict` to confirm the new target is healthy
before pushing):

```sh
git tag -f b1.0.2 origin/main
git push -f origin b1.0.2
```

### Verifying a downloaded release asset

Every release publishes a `sha256` sidecar next to the zip (issue #69).
Verify an asset before installing it:

```sh
# macOS
shasum -a 256 -c QueryHop-1.0.2-macos-universal-unsigned.zip.sha256
# Linux
sha256sum -c QueryHop-1.0.2-macos-universal-unsigned.zip.sha256
```

When a **signed + notarised** asset is present (the five `APPLE_*` repo
secrets are configured), run the post-publish checklist on a clean macOS
machine (issue #68):

```sh
unzip QueryHop-1.0.2-macos-universal.zip
codesign --verify --deep --strict "QueryHop.app"   # signature valid
xcrun stapler validate "QueryHop.app"               # stapled notarisation receipt
spctl -a -vvv -t execute "QueryHop.app"             # Gatekeeper accepts it
```

`scripts/verify-signed-artifact.mjs` automates exactly these checks and is
the gate the release workflow runs on the exact zip it is about to upload
— a signed run cannot publish an unsigned or broken bundle.
4. `scripts/check-release-drift.mjs` (wired into CI's validate job) fails
   the build until a release exists for the manifest version, so the
   release can't drift 18 months behind main again (#54).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/additional-feature`)
3. Commit your changes (`git commit -m 'Add some awesome feature'`)
4. Push to the branch (`git push origin feature/additional-feature`)
5. Open a Pull Request

## License

This project is licensed under the GPLv3 License - see the LICENSE file for details.
