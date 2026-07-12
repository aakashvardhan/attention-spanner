# Google Calendar setup

The calendar integration (📅 Today card, assistant "block 2–3pm" commands,
briefing mentions, focus time-blocking) authenticates with
`chrome.identity.getAuthToken`, which needs a Google Cloud OAuth client tied to
this extension's id. One-time setup, ~10 minutes.

## 1. Pin the extension id

Chrome derives an unpacked extension's id from its path unless the manifest has
a `key`. The OAuth client registration needs a stable id, so generate one:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out gcal-key.pem
openssl rsa -in gcal-key.pem -pubout -outform DER | base64 | tr -d '\n'
```

Paste the base64 output (one long line) into `.env.local` as
`VITE_CRX_PUBLIC_KEY=...`. Keep `gcal-key.pem` out of git (it isn't needed
again unless you want to re-derive the same id).

Then `npm run build`, load/reload the unpacked extension from `dist/`, and copy
the now-stable **extension ID** from `chrome://extensions`.

> Alternative: if the extension is published on the Chrome Web Store, skip the
> key and use the store id directly.

## 2. Google Cloud project

1. [console.cloud.google.com](https://console.cloud.google.com) → create (or
   pick) a project.
2. **APIs & Services → Library** → search **Google Calendar API** → Enable.

## 3. OAuth consent screen

**APIs & Services → OAuth consent screen**:

- User type **External**, publishing status **Testing** (fine for personal use;
  no verification needed).
- Add your own Google account under **Test users**.
- Scopes: add `https://www.googleapis.com/auth/calendar.events`
  (read/write events — the extension never requests broader calendar access).

## 4. OAuth client id

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Chrome Extension**
- Item ID: the extension id from step 1.

Copy the generated client id (ends in `.apps.googleusercontent.com`) into
`.env.local` as `VITE_GCAL_CLIENT_ID=...`.

## 5. Build and connect

```bash
npm run build
```

Reload the extension, open **Settings → Google Calendar → Connect** — Chrome
shows the Google consent screen once, then the 📅 Today card fills in.

## Troubleshooting

- **"bad client id" / "invalid OAuth2 Client ID"** — the extension id Chrome is
  running doesn't match the id registered on the OAuth client. Rebuild after
  setting `VITE_CRX_PUBLIC_KEY`, reload, re-check the id in
  `chrome://extensions` against the client registration.
- **`getAuthToken` errors immediately** — the Chrome *profile* must be signed
  in to Google (Chrome settings → sync/sign-in). Chromium builds without
  Google API keys can't use `chrome.identity.getAuthToken` at all.
- **Consent screen loops / "access blocked"** — your account isn't listed as a
  test user while the consent screen is in Testing mode.
- **Feature invisible** — either env var blank at build time removes `oauth2`
  from the manifest; the UI then shows setup hints instead of a Connect button.
