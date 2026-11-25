## Summary

<!-- What changes and why. One or two sentences, then bullets. -->

## Test plan

- [ ] `npm test` (node --test) passes locally
- [ ] If this touches extension/host-app source: the macOS CI build job passes
- [ ] If this changes user-visible behaviour, the test suite, or a CI guard:
      a `CHANGELOG.md` `[Unreleased]` entry was added in this PR, citing the
      issue(s) below (the changelog-drift guard, issue #182, fails the push
      otherwise)

## Issues

<!-- Load-bearing: GitHub only closes issues on merge when the body carries a
     close keyword. Write "Fixes #N" / "Closes #N" per issue. Bare issue
     numbers in the summary do NOT close on merge. -->

Fixes #

## Merging

Squash-merge this PR (see the README, Contributing → Merging): the squash
subject can cite both the issues and `(#PR)`, keeping the `[Unreleased]`
changelog entry reconcilable with the merge commit.
