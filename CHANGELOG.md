# Changelog

All notable changes to QueryHop are documented here, following the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

This file is the single source for GitHub release notes: the release
workflow (issue #117) assembles each release body from the section that
matches the release version, and `scripts/check-changelog.mjs` fails a
push if the current version's section is missing or empty. Cut a release
by adding its section here in the same commit that bumps the version
(see the README, "Releasing").

## [Unreleased]

Work on `main` since 1.0.2, not yet cut as a release:

- **Service worker declaration fix** — the MV3 service worker is now
  declared explicitly in `manifest.json`, the root cause of the e2e net
  running degraded on CI (issue #110).
- **Redaction hardening** — the #12 term-redaction contract is enforced
  on the console path, the unparseable-URL fallback, blocked-scheme URL
  bodies, path-embedded terms, and authority userinfo; the log-relay
  `Error` loss is fixed (issues #91, #92, #94, #95, #96, #102, #103,
  #104).
- **Safari 14.0 JS floor** — the shipped extension modules no longer use
  RegExp lookbehind (unsupported before Safari 16.4), with a CI guard
  against reintroducing it (issues #98, #99, #100, #104).
- **Node engines contract** — `package.json` declares the Node range the
  repo is guaranteed to run on, and CI fails if the pin or any workflow
  drifts outside it (issues #113, #114, #115).
- **Release changelog source** — `CHANGELOG.md` is now the single source
  for GitHub release notes: the release workflow assembles each release
  body from the section matching the release version, and CI fails if the
  current version's section is missing or empty (issue #117).
- **Stale-tag gate at release time** — the release workflow now refuses
  to build from a tag that predates the current `release-macos.yml`
  (or points off the default branch), so a forgotten tag re-point can no
  longer silently ship a binary built by the old pipeline (issue #118).
- **Full-tier tripwire split** — the e2e full-tier freshness tripwire now
  only hard-fails a push when the push is gate-related (touches the gate
  workflow, the guard, or the e2e tier tests); a schedule outage no
  longer bricks every unrelated PR until the next Sunday fire (issue
  #119).
- **User-managed presets** — the preset dropdown now has an "Add preset"
  form (name + URL, prefilled from the URL field) and per-row inline
  rename/delete actions for your own search URLs. Entries are validated
  with the same rules as the main URL field (including the blocked-scheme
  denylist, which unsafe mode does not relax), are listed below the
  built-ins, are reachable by the dropdown keyboard nav, and are persisted
  to `chrome.storage.local` immediately (issue #126).
- **README: stale iOS/iPadOS promise removed** — the key-features list
  no longer promises "iOS/iPadOS support coming soon!"; QueryHop is a
  Safari Web Extension for macOS, and the Requirements section (Safari
  14.0 on macOS 11.5+) remains the accurate platform statement (issue #128).

## [1.0.2] - 2026-09-29

First release in 18 months — the newest release before this one
(1.0-2, 2025-04-04) predates the 1.0.2 version bump and most of the
year's work.

- **Settings cache fix** — the background worker now invalidates its
  rules cache when settings change in storage, so edits made outside the
  popup apply immediately (issue #55).
- **Popup module split** — the preset picker and debug-log pane moved
  out of `popup.js` into `popupPreset.js` / `popupDebug.js`;
  `popup.js` is now the thin orchestrator (issues #53, #56).
- **Save-flow hardening** — the save flow now surfaces an error when the
  background script fails to acknowledge a rules update, instead of
  flashing success (issue #37); Enter-to-save is bound on keydown
  (issue #39).
- **Version-sync guards** — `manifest.json` and the three
  `MARKETING_VERSION` entries must stay in lockstep; CI fails if only
  one side is bumped (issues #48, #49, #50).
- **Full i18n** — English and German locales for the popup, host window
  and preset names, with consistency tests (issues #21, #26, #29,
  #33–35).
- **Debug log** — opt-in background-owned ring buffer with view cap,
  truncation disclosure, redacted query params, and a Copy-log button
  (issues #8, #12–15, #17–19).
- **Module architecture** — `background.js` split into `bgCommon` /
  `bgSettings` / `bgDebugLog`; pure logic extracted into
  `popupRules.js` / `popupState.js` / `popupI18n.js` for unit testing
  (issues #14, #16, #22, #51).
- **Test suite** — 251 node:test cases plus a 16-test Swift XCTest
  target, with a macOS Xcode build gate in CI (issues #7, #40–42).

**Assets**

This release was cut from a Linux environment; the macOS universal
binary could not be built there and is **not attached**. An ad-hoc-signed
unsigned universal binary was uploaded by the release workflow
(`QueryHop-1.0.2-macos-universal-unsigned.zip`); a notarised
`QueryHop-1.0.2-macos-universal.zip` is still tracked by issue #60.

## [1.0-2] - 2025-04-04

Updated version of QueryHop (formerly Safari Search Redirector) that
adheres to Apple's App Store guidelines. Functionally the same as 1.0
(-1), but:

- The extension has been renamed to QueryHop.
- Entitlements are only enabled where necessary for usage.
- Message handling in the background is optimised to lower saving time.

## [1.0] - 2025-04-03

Initial release of Safari Search Redirector.

Current features:

- Redirection from default search engines before they begin to load.
- Integrated preset options for popular alternative search engines.
- Custom URL configuration for any search engine.
- Advanced option to bypass URL validation for specific use cases.

Requires Safari 14.0 or later on macOS 11.0+.
