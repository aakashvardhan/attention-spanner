# Gmail setup

The inbox integration (📥 Inbox card, `triage my inbox`, "make a task from that
email") runs on an OAuth client **you** create in **your own** Google Cloud
project — the same arrangement as the calendar, and it can be the very same
client. One-time setup, ~10 minutes.

**What the extension can and cannot do with your mail.** It lists unread
messages and reads their `From`, `Subject`, and Gmail's own one-line snippet;
it never requests message bodies (`format=metadata`, always). It can archive
and label a message when you confirm. It has **no** send or compose scope, so
it cannot write, draft, or send mail in your name. Tokens and everything it
fetches stay in this browser profile and are excluded from cloud sync.

## 1. Copy your redirect URI

Open **Settings → Gmail**. It shows a line like:

```
https://<your-extension-id>.chromiumapp.org/
```

Copy it; step 4 needs it verbatim. It's the same URI the calendar section
shows — one install, one redirect.

## 2. Google Cloud project

1. [console.cloud.google.com](https://console.cloud.google.com) → create (or
   pick) a project. **If you already set up Google Calendar, use that project.**
2. **APIs & Services → Library** → search **Gmail API** → Enable.

## 3. OAuth consent screen

**APIs & Services → OAuth consent screen** (newer consoles: **Google Auth
Platform → Branding / Audience**):

- Audience **External**.
- Add **every** Google account you plan to connect under **Test users** — both
  your personal address and your school one. Sign-in fails with `access_denied`
  for any account not listed.
- Scopes: add `https://www.googleapis.com/auth/gmail.readonly` and
  `https://www.googleapis.com/auth/gmail.modify`.

> **Publish the app — this matters more for Gmail than for Calendar.** Both
> Gmail scopes are *restricted*, and an External app left in "Testing" is
> issued refresh tokens that expire after **7 days**. Leave it there and you
> will be reconnecting both mailboxes every week. Go back to **Audience** and
> **Publish app**. Sign-in then shows a "Google hasn't verified this app"
> interstitial once (Advanced → "Go to …") and the connection stays put.
> Verification only matters for removing that warning and for going past 100
> users; neither applies to a personal install.

## 4. OAuth client

If you already made a Web application client for Calendar, **reuse it** — just
confirm its redirect URI still matches step 1, and skip to step 5.

Otherwise, **APIs & Services → Credentials → Create credentials → OAuth client
ID**:

- Application type: **Web application**.
- Under **Authorized redirect URIs**, add the URI from step 1 exactly as shown,
  trailing slash included.

Copy the **client ID** and the **client secret**.

## 5. Connect each mailbox

In **Settings → Gmail**: paste the client id and secret, click **Save
credentials**, then **Connect Gmail**. Approve the two Gmail scopes.

Then click **Connect another account** and repeat for your second address. That
second run forces Google's account chooser (`prompt=consent select_account`),
so pick the *other* account — otherwise Google silently re-authorizes the one
you're already signed in as, and you end up with one mailbox connected twice.
(Re-authorizing an address that's already connected just refreshes that row, so
this is recoverable, not fatal.)

Each connected mailbox gets its own row with its own status and its own error.

## Triage

Sorting mail into **Today / This week / Read only / Archive** needs a cloud API
key (**Settings → Assistant**) — two mailboxes' worth of unread mail is well
past what the on-device model can hold. Without a key the Inbox card still
lists your unread mail, unsorted and honestly labelled as such.

A scheduled triage runs once a day at the time set in **Settings → Gmail**
(default 08:30), skipped during quiet hours. Clear the time to turn it off; the
**Refresh** button on the Inbox card always works.

## Troubleshooting

- **Both accounts connect, then immediately show an error on the first triage**
  — the sign-in was fine; the API call was not. Two causes, and the error text
  tells you which:
  - *"The Gmail API is not enabled on your Google Cloud project"* — you enabled
    the Calendar API in this project but not the Gmail one. **APIs & Services →
    Library → Gmail API → Enable**, wait a minute, hit **Triage now** again.
    You do **not** need to reconnect; the accounts stay connected.
  - *"This connection has no permission to read mail"* — the consent screen has
    no Gmail scopes on it, so Google issued a valid token that cannot read
    anything. Add both scopes under **OAuth consent screen → Scopes**, then
    disconnect and reconnect each account so the new consent is granted.
- **`admin_policy_enforced`** — a Google Workspace administrator (your
  university, for instance) blocks unapproved third-party apps from accessing
  that tenant's mail. There is no setting on your side that overrides this;
  either the admin allowlists the app's client id, or that mailbox cannot be
  connected. The error is stored on that account's row and the other mailbox
  keeps working normally.
- **`access_denied`** — that account isn't in the consent screen's Test users
  (step 3), or you dismissed the consent window.
- **"Google did not return a refresh token"** — Google withholds one when the
  app is already authorized for that account. Remove it at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
  and connect again.
- **Reconnecting every week** — the app is still in "Testing". Publish it
  (step 3).
- **"Google rejected the token request … `invalid_client`"** — the id and secret
  aren't from the same client, or one picked up a stray space. Clear the
  credentials in Settings and paste them again.
- **Both rows show the same address** — the second connect reused the signed-in
  session. Disconnect one, sign out of that Google account in this browser or
  use the chooser carefully, and connect again.
