# Google Calendar setup

The calendar integration (📅 Today card, assistant "block 2–3pm" commands,
briefing mentions, focus time-blocking) runs on an OAuth client **you** create
in **your own** Google Cloud project. Nothing is baked into the build: no client
id in the manifest, no shared project, no dependency on anyone else's Google
account staying healthy. One-time setup, ~10 minutes.

Everything you paste stays in this browser profile's extension storage and is
never synced.

## 1. Copy your redirect URI

Open the extension's **Settings → Google Calendar**. It shows a line like:

```
https://<your-extension-id>.chromiumapp.org/
```

That's this install's OAuth redirect URI, derived from the extension id — so
it's yours and it's already correct. Copy it; step 4 needs it verbatim.

> The extension id changes if you load the extension from a different folder.
> Set `VITE_CRX_PUBLIC_KEY` in `.env.local` (base64 DER public key) to pin it
> and the redirect URI stays stable. Optional — if you skip it and the id does
> move, re-copy the new URI into the client.

## 2. Google Cloud project

1. [console.cloud.google.com](https://console.cloud.google.com) → create (or
   pick) a project.
2. **APIs & Services → Library** → search **Google Calendar API** → Enable.

## 3. OAuth consent screen

**APIs & Services → OAuth consent screen** (newer consoles: **Google Auth
Platform → Branding / Audience**):

- Audience **External**. Internal is offered only under a Google Workspace org
  and restricts sign-in to that org's accounts.
- Add your own Google account under **Test users**. Sign-in fails with
  `access_denied` if you skip this.
- Scopes: add `https://www.googleapis.com/auth/calendar.events` (read/write
  events — the extension never asks for broader calendar access).

Then, once sign-in works end to end, go back to **Audience** and **Publish
app**. An External app in "Testing" is issued refresh tokens that expire after
**7 days**, so leaving it there means reconnecting the calendar every week. In
production, sign-in shows a "Google hasn't verified this app" interstitial once
(Advanced → "Go to …") and the connection then stays put. Verification only
matters for removing that warning and for going past 100 users — neither applies
to a personal install.

## 4. OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**.
- Under **Authorized redirect URIs**, add the URI from step 1 exactly as shown,
  trailing slash included.

Copy the **client ID** and the **client secret**.

> Not "Chrome Extension": that type pins the client to a single extension id,
> which is what breaks whenever the id moves and what forces every clone of this
> repo to depend on one person's Cloud project. Google issues a secret for the
> Web application type and wants it at the token endpoint even alongside PKCE.
> It's your own, it stays on this device, and it guards nothing but your
> project's quota.

## 5. Connect

Back in **Settings → Google Calendar**: paste the client id and secret, click
**Save credentials**, then **Connect Google Calendar**. A Google sign-in window
opens; approve the calendar scope and the 📅 Today card fills in.

Google can take a few minutes to propagate a newly created client. If the first
attempt fails, wait and retry before changing anything.

## Troubleshooting

- **"Access blocked: … request is invalid" (Error 400: `invalid_request`)** —
  the redirect URI registered on the client doesn't match this install's.
  Re-copy it from Settings; it has to match character for character.
- **`access_denied`** — your account isn't in the consent screen's Test users
  (step 3), or you dismissed the consent window.
- **"Google rejected the token request … `invalid_client`"** — the id and secret
  aren't from the same client, or one picked up a stray space. Clear the
  credentials in Settings and paste them again.
- **"Reconnect Google Calendar in Settings."** — the refresh token is gone (you
  removed the app from your Google account, or the project was disabled). Click
  Connect again.
- **A flagged or suspended project** — Google restricts OAuth on projects
  carrying an enforcement notice, and sign-in then fails at the consent screen
  even though the client is configured correctly. Check the banner in the Cloud
  console. Because the client is yours, this can only ever affect your own
  install.
