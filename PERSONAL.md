# Personal-branch setup

This branch (`personal`) carries the integrations that depend on
personally-registered credentials and therefore are not part of the public
`main` branch:

| Integration | Credential it needs | Where it's configured |
|---|---|---|
| Google Calendar | Your own Google Cloud OAuth client (personal-use approval) | `.env.local` + `gcal-key.pem` |
| Notion push | Your own Notion internal-integration token | Options page (stored in `chrome.storage`) |
| Cloud sync + iOS app | Your own Firebase project | `.env.local` (+ `GoogleService-Info.plist` for iOS) |

Nothing here is committed: `.env.local` and `gcal-key.pem` are gitignored, and
the Notion token lives only in extension storage. A build made with a blank
`.env.local` has all three features disabled/hidden.

---

## 1. Google Calendar

Full walkthrough: **[docs/google-calendar-setup.md](docs/google-calendar-setup.md)**.
Summary:

1. Generate/keep `gcal-key.pem` in the repo root (gitignored). It pins the
   extension id so the OAuth client registration stays valid across builds.
2. In Google Cloud Console, create a **Chrome Extension** OAuth client for that
   extension id and enable the Google Calendar API.
3. Copy the template and fill in both values:

   ```bash
   cp .env.example .env.local
   # VITE_CRX_PUBLIC_KEY=<base64 DER public key from gcal-key.pem>
   # VITE_GCAL_CLIENT_ID=<...>.apps.googleusercontent.com
   npm run build
   ```

4. Reload the extension, open the dashboard's 📅 Today card, and click
   **Connect Google Calendar**.

Leaving either env var blank omits the manifest `oauth2`/`key` entries and the
feature stays dormant. The OAuth client is registered for personal use — don't
distribute builds that embed it.

## 2. Notion sync (one-way)

1. Create an internal integration at <https://www.notion.so/my-integrations>
   and copy its secret token.
2. Share the target databases (links / brain dumps / tasks / reading log) with
   the integration.
3. In **Options → Notion**, paste the token, click **Test connection**, pick a
   database per push type, and enable the pushes you want.

Pushes queue offline and flush every 10 minutes; a revoked token pauses the
queue until you paste a fresh one.

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
