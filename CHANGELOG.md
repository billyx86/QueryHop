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
- **Preset dropdown keyboard nav fixed for real browsers** — the
  ArrowDown/ArrowUp handlers in `popupPreset.js` called `.indexOf` on a
  `querySelectorAll` result; in a real browser that is a NodeList (no
  `indexOf`) and threw a `TypeError` on the first keypress, while the
  unit tests stayed green because the harness's fake `querySelectorAll`
  returned a plain Array. The handlers now spread to an Array first
  (matching the existing `updateButtonText()` pattern), and the harness
  returns a NodeList-shaped result — ArrayLike, `item()`, iterable, no
  `Array.prototype` methods — pinned by a new fidelity test
  (`tests/popup-harness-fidelity.test.js`) so this class of
  test-vs-browser divergence cannot silently reappear (issue #131).
- **README list fixes** — the "From GitHub" install steps no longer jump
  from 1 to 3, and the stray `4.` left dangling after the release
  verification checklist (its content already lives in the "two
  invariants" list) is removed (issue #132).
- **Preset listbox announces its selection** — every preset option in
  the dropdown (the static built-ins in `popup.html` and each rendered
  user row) now carries `aria-selected`, synced from a single choke
  point (`syncAriaSelected()` inside `updateButtonText()`) so a screen
  reader can tell which preset the current URL matches after any
  selection path — built-in or user row, by click, by Enter/Space, or
  by typing (issue #134).
- **Preset backup core** — three pure helpers in `popupState.js` for the
  export/import flow: `serializeUserPresetsForExport()` (the export file
  is exactly the stored `{ name, url }[]` shape, normalized first so a
  broken entry can never ship in a backup), `parsePresetImport()` (bare
  array or a `{ userPresets: [...] }` wrapper; `invalid-json` /
  `not-a-list` on anything else), and `mergeImportedPresets()` (every
  imported URL re-validated through the same `validateSearchUrl()` the
  add flow uses; one bad URL rejects the whole import atomically,
  duplicates are skipped and counted, inputs never mutated) (issue #135).
- **Preset export/import UI** — the preset dropdown's manage row gains an
  Export button (downloads `queryhop-presets.json` — exactly the stored
  `{ name, url }[]` list, normalized first — through a Blob +
  `URL.createObjectURL` one-shot anchor whose programmatic click stops
  propagation so it never trips the outside-click close), an Import
  button (opens the visually-hidden file input; the read → parse → merge →
  persist path is atomic: one invalid URL rejects the whole import,
  blocked schemes are refused even in unsafe mode), and an aria-live
  status line that reports the outcome in localized copy (nine new en/de
  i18n keys, no runtime placeholders) (issue #135).
- **Rename input: every key stays local** — while a preset name is being
  edited, the listbox keydown handler used to preventDefault Space and
  the arrows, swallowing the space character and killing caret movement
  in the middle of a name. Every keydown in the rename input now stops
  propagation unconditionally (Enter/Escape keep their commit/cancel
  behavior on top of local delivery) (issue #138).
- **Enter saves from the add-preset form** — pressing Enter in either
  field of the Add preset form (name or URL) now saves the preset instead
  of bubbling into the page default; the form-level keydown handler
  preventDefaults Enter and routes to the same save path as the Save
  button (issue #139).
- **Keyboard path to the preset row actions** — the rename/delete buttons
  are nested inside the listbox options, where Enter/Space are reserved
  for applying the preset, so the row actions were mouse-only. With a
  user-preset row focused, F2 (the universal rename key) opens the inline
  rename editor, and Delete/Backspace delete the preset through the
  two-stage confirm below; the rename input's key isolation is preserved
  (Backspace in the name field edits the name, never arms the delete)
  (issue #140).
- **Refused renames are no longer silent** — when `renameUserPreset()`
  refuses a rename (blank name), the popup now keeps the input open with
  focus and shows the localized reason on the aria-live manage status
  line, instead of discarding the edit (issue #141).
- **Two-stage preset delete** — a misclick on the ✕ used to destroy a
  user's own preset immediately. The first press now arms the button (it
  turns into a localized "Sure?" confirm chip, announced on the aria-live
  status line naming the preset) and the second press within a few
  seconds deletes; a click anywhere else or the window elapsing cancels
  the arm. The delete keyboard path (#140) drives the same two stages
  (issue #142).
- **Rejected preset imports name the offending preset** — a failed
  import used to show only the validation reason, so a long backup with
  one bad URL gave no hint which entry was at fault. `mergeImportedPresets()`
  now surfaces a copy of the offending `{ name, url }` entry, and the
  manage status reads it through the new `preset_import_failed` key
  (`Could not import "$1" ($2) — $3`) (issue #144).
- **Import success status reports the counts** — a successful import
  used to announce a flat "Presets imported" even when most of the file
  was skipped as duplicates. The status now carries both numbers
  through `preset_import_counts` (`Presets imported: $1 added, $2
  skipped`), so a partial merge is visible at a glance; the key
  replaces `preset_import_success` (issue #145).
- **User preset cap** — user presets can now grow without bound: the
  add form and the import path both accepted new entries forever, so a
  user re-importing ever-larger backups could fill the dropdown beyond
  usefulness. `popupState.js` exports `USER_PRESET_LIMIT = 100`;
  `addUserPreset()` refuses at the cap with a `limit-reached` status the
  add form renders through `preset_limit_reached` (`The preset limit of
  $1 has been reached. Delete a preset first.`), and
  `mergeImportedPresets()` counts cap overflow in its own `overflow`
  counter so a capped import is still a usable partial merge (issue
  #146; the counter was split out from `skipped` by issue #150).
- **Preset import accepts a single bare object** — a backup file holding
  one `{ name, url }` object (no array, no `userPresets` wrapper) used
  to fail with "That file does not contain a preset list".
  `parsePresetImport()` now recognizes the single-object shape and
  imports it as a one-element list, so a user with one preset who copies
  just that object gets a working import (issue #152).
- **Dropped import entries are counted and surfaced** — a hand-edited
  backup with an incomplete entry (blank name or URL, a non-object
  element) used to vanish silently: the import status looked identical
  to a clean merge. `parsePresetImport()` now returns a `dropped`
  count, and when it is non-zero the success status adds it via the new
  `preset_import_counts_dropped` key (`Presets imported: $1 added, $2
  skipped, $3 dropped (missing name or URL)`) (issue #151).
- **A full list says the list is full** — importing new presets into a
  list already at the 100-entry cap showed "Those presets are already in
  your list", which was factually wrong: the presets were new, the list
  was full. `mergeImportedPresets()` now returns the distinct `overflow`
  counter and an `atCap` flag, and the zero-added import status picks
  its copy from the *reason* the adds were zero — a full list reads the
  new `preset_import_list_full` key (`The preset list is full ($1).
  Delete a preset to import more.`) instead of the all-skipped copy
  (issue #150).
- **Armed-delete message actually names the preset** — the two-stage
  delete's armed copy used the bare `%1` token, which Chrome's i18n does
  not substitute, so the status literally showed `%1` instead of the
  preset name. The en/de messages now use the positional `$1` form, a
  new i18n-consistency invariant bans bare `%N` tokens in locale
  messages, and the `popupPreset.js` comment that claimed Chrome used a
  `%1` token is corrected (issue #144).
- **Debug log no longer loses entries to concurrent writes** — the
  `chrome.storage.session` persist path is a read-mutate-write round-trip
  with no synchronization, so the 5 ms per-tab debounce let appends from
  concurrent navigations overlap on the awaits and run last-writer-wins,
  silently dropping entries and under-reporting the #19 evicted count.
  Appends now run strictly after the previous one settles (the chain
  release runs on both outcomes, not a rejection-only catch), and reads
  and clears drain the chain before snapshotting so a same-task read
  observes every issued append (issue #154).
- **Path-embedded search terms are now recognized and redacted** —
  `extractSearchQuery` only read the term from `url.searchParams` and the
  `#hash` param string, so an engine whose result URL carries the term in
  the path could never be matched. An engine opts in with a `pathPattern`
  RegExp (one capture group, tried only after the queryParam/fragment
  lookups); the captured segment is percent-decoded so
  `createTargetUrl` re-encoding it into the user's `%s` template is
  lossless. The ring buffer's `originalUrl`/`targetUrl` now go through
  `redactTermFromUrl` at both `appendDebugLog` sites — a strict superset
  of the old param-only redaction — so a path-embedded term no longer
  reaches the ring buffer or console mirror in plaintext (issues #155,
  #12).
- **23 more Google ccTLDs redirect** — the engine pattern was pinned to
  12 Google ccTLDs, so a user whose default Google domain was one of the
  largest missing ones (`.com.mx`, `.com.sg`, `.com.hk`, `.com.tw`,
  `.com.my`, `.co.za`, `.co.th`, `.com.ar`, `.com.tr`, `.pl`, `.ro`,
  `.no`, `.dk`, `.se`, `.fi`, `.at`, `.ch`, `.be`, `.pt`, `.gr`, `.cz`,
  `.hu`, `.il`) got no redirect at all. The flat TLD alternation gains all
  23, with `manifest.json` host_permissions, the Safari `Info.plist`
  Allowed Domains, and the drift-guard sample lists all moving in
  lockstep (issue #156).
- **Brave Search is a redirect source** — `searchEngines` in
  `bgCommon.js` gains the Brave entry (`search.brave.com/search`,
  `q` param), with the `manifest.json` host_permissions and the Safari
  `Info.plist` Allowed Domains moving in lockstep, the README engine
  list, and the five drift-guard test pins (engine count 7 → 8, pinned
  source set, TLD-sample table, redirect-URL list, redaction param
  check). Brave was already a built-in destination preset; the two
  lists stay deliberately independent (issue #160).
- **Copy-log tooltip says "rolling window"** — the copy-log button's
  tooltip (en/de + `popup.html` `title`, kept in lockstep by the
  i18n-consistency guard) read "Copy the *full* (redacted) debug log",
  which overstates what the button copies: the background ring buffer
  is a 200-entry rolling window and the oldest entries are dropped
  first (the disclosure the #19 header already prints). The copy now
  names the rolling window and the drop order (issue #159).
- **e2e net covers a Google ccTLD navigation** — the full tier's
  behavioral net navigated `google.com` only, so a regression that
  broke just the ccTLD arm of the redirect pattern (malformed
  alternative, a dropped host_permission for one TLD, an Info.plist
  drift the list-vs-list unit guards cannot see) stayed green. The
  net now navigates `google.co.uk` (one of the 23 ccTLDs from #156)
  with the extension enabled and asserts the same network-independent
  proof as the `.com` scenario — a pre-redacted `redirect` entry for
  the ccTLD original URL, targeting the custom engine, with the raw
  term absent (#12 contract) — and scenario 2's log-length baseline
  moves past the new entry (issue #158).
- **e2e net covers ccTLD matching across TLD shapes** — the #158
  scenario navigated `google.co.uk` only, so a regression that broke
  another alternative shape (a 2-char TLD or a two-level ccTLD) would
  still pass the browser net. The scenario now iterates a fixed
  sample — one navigation per alternative shape (`google.de`,
  `google.co.uk`, `google.com.au`, each with its own query literal) —
  asserting the same per-navigation proof: a pre-redacted `redirect`
  entry for that host, the Google engine matched, and the raw term
  absent from the entry (#12 contract). The sample is deliberately
  fixed rather than a loop over all 34 alternatives: the unit tests
  pin the full set, and the full-tier runtime stays bounded (issue
  #162).

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
