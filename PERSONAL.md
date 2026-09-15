# Personal-branch setup

This branch (`personal`) existed to carry integrations that depend on
personally-registered credentials and could not ship on the public `main`
branch: Google Calendar, Gmail, and Firebase cloud sync with the iOS app.

**All three are gone.** Firebase sync was removed in schema v20; Calendar and
Gmail were removed in v22, along with the assistant that used them. The
extension now has no account, no OAuth client, and no authenticated request to
anyone — so there is nothing left on this branch that needs a credential, and
nothing that has to be kept out of a public build.

## What still differs from `main`

Only `ios/`, and it is orphaned. The Swift package in `ios/ADHDReaderCore`
mirrors `src/shared` logic for features that no longer exist (tasks, brain
dumps, gym streaks, XP, flashcards), and the sync transport it talked to was
deleted in v20. `ios/ADHDReader` is a nested git repository recorded as a
gitlink with no `.gitmodules`, so a fresh clone does not materialize it.

**This needs a decision.** Either the iOS app is being revived — in which case
`ADHDReaderCore` needs rewriting against the current schema — or `ios/` should
be deleted and the two branches collapsed into one. Leaving it as-is means
carrying a second codebase that models a product that no longer exists.

## Packaging

`npm run package` used to embed `.env.local` (Firebase config, Google OAuth
client id) into the shipped bundle, which is why packaging from this branch
needed care. Nothing reads those variables any more, so the warning no longer
applies — but check `.env.local` before shipping a build regardless, and delete
the stale `gcal-key.pem` at the repo root if nothing else wants it.

## Branch workflow

- Shared feature work happens on **`main`**.
- Pull it in with `git checkout personal && git merge main`.
- The removal commits on main were recorded here with a `merge -s ours`, so
  merging main never re-deletes these features.
