# Personal-branch setup

This branch (`personal`) carries the integrations that depend on
personally-registered credentials and therefore are not part of the public
`main` branch:

| Integration | Credential it needs | Where it's configured |
|---|---|---|
| Google Calendar | Your own Google Cloud OAuth client (personal-use approval) | Options page (stored in `chrome.storage`) |
| Gmail | The same Google Cloud OAuth client, with the Gmail API enabled | Options page (stored in `chrome.storage`) |
| Cloud sync + iOS app | Your own Firebase project | `.env.local` (+ `GoogleService-Info.plist` for iOS) |

Nothing here is committed: `.env.local` and `gcal-key.pem` are gitignored, and
the Google credentials live only in extension storage. A build made with a
blank `.env.local` has cloud sync disabled; the Calendar and Gmail clients are
configured at runtime and stay dormant until you fill them in.

---

## 1. Google Calendar

Full walkthrough: **[docs/google-calendar-setup.md](docs/google-calendar-setup.md)**.
Summary:

1. In Google Cloud Console, enable the Google Calendar API and create a **Web
   application** OAuth client whose authorized redirect URI is the one shown in
   **Settings → Google Calendar**.
2. Paste the client id and secret into that same Settings section and click
   **Connect Google Calendar**.

No build step and no env vars: the client is entered at runtime, so a clone of
this repo sets up its own rather than inheriting mine. `gcal-key.pem` /
`VITE_CRX_PUBLIC_KEY` are now optional — they only pin the extension id, which
keeps the redirect URI stable if the unpacked folder ever moves.

## 2. Gmail

Full walkthrough: **[docs/gmail-setup.md](docs/gmail-setup.md)**. Summary:

1. In the *same* Cloud project, enable the **Gmail API** and add the
   `gmail.readonly` + `gmail.modify` scopes to the consent screen.
2. Paste the same client id and secret into **Settings → Gmail**, then
   **Connect Gmail** once per mailbox.

Two things that bite here and not on Calendar: the Gmail scopes are
*restricted*, so an app left in "Testing" expires refresh tokens after 7 days
(publish it), and a Workspace tenant can refuse the app outright with
`admin_policy_enforced` — which takes down that one mailbox, not the other.

## 3. Firebase cloud sync (extension ↔ iOS)

Sync is off until Firebase web config is present at build time:

```bash
cp .env.example .env.local
# paste the VITE_FIREBASE_* values from Firebase console:
# Project settings → General → Your apps → (Web app) → SDK setup → Config
npm run build
```

In the Firebase console you need: a Firestore database, **Email/Password**
auth enabled, and per-user security rules on `users/{uid}`. Sign in from
**Options → Account**; the same email/password on iOS yields the same uid, so
both devices share one dataset. The web `apiKey` is an identifier rather than
a secret, but restrict it in Google Cloud Console anyway.

Sync is conflict-tolerant: last-write-wins by `updatedAt` for user records,
field-wise max for time-series, tombstones for deletes (see
`src/shared/sync/merge.ts`).

## 4. iOS companion app

- **`ios/ADHDReaderCore`** — dependency-free Swift package mirroring
  `src/shared` logic. Verify with `cd ios/ADHDReaderCore && swift run CoreVerify`.
- **`ios/ADHDReader`** — SwiftUI app + Xcode project. Register an **iOS app**
  in the same Firebase project (bundle id `com.aakashvardhan.ADHDReader`),
  download `GoogleService-Info.plist`, and drop it into
  `ios/ADHDReader/ADHDReader/` (the synchronized folder bundles it
  automatically). Then open `ios/ADHDReader/ADHDReader.xcodeproj` and run.

> **Note:** `ios/ADHDReader` is its own nested git repository (recorded here
> as a gitlink with no `.gitmodules`), so a fresh clone of this branch will
> not materialize it — restore it from a backup or re-add the remote before
> building the iOS app.

## 5. Packaging warning

`npm run package` embeds whatever is in `.env.local` — Firebase config and the
Google OAuth client id — into the shipped bundle. **Package from a clean env
(or from the `main` branch) for anything you hand to other people.**

## 6. Branch workflow

- Shared feature work happens on **`main`** (public, none of the above).
- Periodically pull it in: `git checkout personal && git merge main`.
- Personal-only work commits directly to `personal`.
- The removal commits on main were recorded here with a `merge -s ours`, so
  merging main never re-deletes these features.
