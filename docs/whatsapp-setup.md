# WhatsApp bridge setup

Add, complete, edit, and delete tasks — plus flashcards, papers, and calendar
events — from WhatsApp. A Firebase Cloud Function receives messages via the
official Meta Business Cloud API and writes to the same Firestore collections
(`users/{uid}/…`) the extension already syncs, so changes appear in the
extension within seconds and survive both directions (deletes write
tombstones; flashcards get their SRS card rows).

```
WhatsApp ⇄ Meta Cloud API ⇄ whatsappWebhook (Cloud Function) ⇄ Firestore ⇄ extension sync
                                            └── Google Calendar API (events)
```

Requirements: the extension's Firebase sync set up and signed in (see
PERSONAL.md), the Firebase project on the **Blaze** plan (Functions needs it;
personal volume stays ≈ $0), a Meta developer account.

## 1. Meta app + WhatsApp number

1. [developers.facebook.com](https://developers.facebook.com) → **Create App**
   → type **Business**.
2. In the app dashboard, add the **WhatsApp** product. You get a free **test
   number** and a temporary access token — enough for personal use (message
   yourself; re-verify the recipient once).
3. Note from **WhatsApp → API Setup**:
   - **Phone number ID** (not the phone number itself)
   - A **permanent access token**: create a System User in
     [business.facebook.com](https://business.facebook.com) → Settings →
     System Users, grant it the app with `whatsapp_business_messaging`, and
     generate a non-expiring token. (The dashboard token dies in 24 h.)
4. **App settings → Basic**: note the **App Secret** (signs webhook payloads).

## 2. Your Firebase UID

Options → Account section shows the signed-in email; the UID is in
[Firebase console](https://console.firebase.google.com) → Authentication →
Users. Copy it.

## 3. Configure and deploy the function

```bash
# once: point .firebaserc at your project
sed -i '' 's/REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID/your-project-id/' .firebaserc

cd functions && npm install

# secrets (prompted for the value each time)
firebase functions:secrets:set WHATSAPP_VERIFY_TOKEN   # any string you invent
firebase functions:secrets:set WHATSAPP_ACCESS_TOKEN   # the permanent token from step 1
firebase functions:secrets:set META_APP_SECRET         # from app settings → Basic
firebase functions:secrets:set ALLOWED_USERS           # "15551234567:yourFirebaseUid"

# non-secret params → functions/.env.<project-id>
echo 'WHATSAPP_PHONE_NUMBER_ID=123456789012345' >> .env.your-project-id
echo 'USER_TIMEZONE=America/Los_Angeles'        >> .env.your-project-id

firebase deploy --only functions
```

The deploy prints the function URL:
`https://us-central1-<project>.cloudfunctions.net/whatsappWebhook`

`ALLOWED_USERS` is the entire access model: senders not on it are dropped
silently — no reply, no processing. Phone numbers are digits only, as Meta
sends them (country code, no `+`).

## 4. Wire the webhook

Meta dashboard → WhatsApp → **Configuration**:

- **Callback URL**: the function URL from the deploy
- **Verify token**: the `WHATSAPP_VERIFY_TOKEN` value you invented
- Click **Verify and save** (the function answers the handshake), then
  **subscribe** to the `messages` webhook field.

## 5. Commands

```
task add Buy milk
task list
task done 2            (or: task done buy milk)
task del 2
task edit 2: Buy oat milk
card add Spanish: hola | hello     (deck optional: card add hola | hello)
paper add https://arxiv.org/abs/1706.03762
paper list
paper del attention
event add 14:00 Dentist            (today 14:00, 1 h)
event add 2026-07-20 09:30 Standup
help
```

Replies are blunt one-liners (`Added: Buy milk`). Anything that doesn't parse
returns the command list.

## 6. Calendar events (optional)

`event add` writes straight to Google Calendar — the extension picks the
event up on its normal 15-minute refresh, no extension changes involved. It
needs a server-side OAuth refresh token for **the same Google account** the
extension's calendar uses:

1. Reuse the OAuth client from docs/google-calendar-setup.md or create a
   **Web application** OAuth client in Google Cloud console; add
   `https://developers.google.com/oauthplayground` as a redirect URI.
2. [OAuth playground](https://developers.google.com/oauthplayground) → gear
   icon → "Use your own OAuth credentials" → paste client id/secret →
   authorize scope `https://www.googleapis.com/auth/calendar.events` →
   exchange for tokens → copy the **refresh token**.
3. Add to `functions/.env.your-project-id`:

```
GCAL_CLIENT_ID=...apps.googleusercontent.com
GCAL_CLIENT_SECRET=...
GCAL_REFRESH_TOKEN=...
```

Redeploy. Unset, `event add` answers "Calendar is not configured".

## Testing without Meta

```bash
cd functions && npm run serve   # functions + firestore emulators
```

- Verify handshake:
  `curl 'http://localhost:5001/<project>/us-central1/whatsappWebhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=42'`
  → responds `42`.
- POST a captured sample `messages` payload (signed with your app secret) and
  check the emulator UI: the task doc must appear under `users/<uid>/tasks/…`
  and a delete must also add a `tasks:<id>` key to `users/<uid>/meta/tombstones`
  — that tombstone is what makes deletions stick against the extension's push.

## Notes

- Record shapes come from `src/shared/sync/recordShapes.ts`, compiled into
  the function — the extension and the bridge cannot drift apart silently
  (covered by `recordShapes.test.ts`).
- Simultaneous edits from phone and extension resolve last-write-wins by
  `updatedAt`, same as two synced devices.
- Meta's free tier (1000 service conversations/month) is far beyond personal
  use. The permanent System User token does not expire but can be revoked in
  Business settings.
