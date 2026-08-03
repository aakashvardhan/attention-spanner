# alphaXiv setup

There is no setup. Unlike Google Calendar, this integration needs no client id,
no `.env.local` entry, and no stable extension id — open **Settings → alphaXiv →
Connect alphaXiv**, sign in, and it works.

This page exists to explain why, and what to do when it breaks.

## How the connection works

alphaXiv exposes its research corpus through an MCP server at
`https://api.alphaxiv.org/mcp/v1`, behind OAuth 2.1.

1. **Dynamic client registration.** On the first connect, the extension POSTs
   its own `chrome.identity.getRedirectURL()` to `/auth/oauth2/register` and
   gets back a `client_id`. Registration is per-install (the redirect URL is),
   so the extension id does not need to be pinned. The id is cached in
   `alphaxiv.clientId` and survives a disconnect.
2. **Authorization code + PKCE.** `chrome.identity.launchWebAuthFlow` opens
   alphaXiv's consent page. There is no client secret — it is a public client,
   and PKCE (S256) is what binds the code to this extension. The window is
   pointed at `/oauth/consent` rather than the authorize endpoint on purpose:
   authorize redirects to `/signin` whenever it cannot see a session cookie,
   which an extension auth window never carries, and `/signin` then bounces a
   signed-in user to the app root and drops the request without an error.
   `consentUrl()` resolves that redirect and rewrites the path.
3. **Tokens.** The access token and refresh token live in
   `chrome.storage.local` under `alphaxiv`, device-local and never synced to
   Firestore. Access tokens refresh silently a minute before expiry, and once
   more on a 401 from the MCP endpoint; a second failure disconnects and asks
   you to reconnect.

## Why this works from a browser extension

alphaXiv's own docs say browser-hosted MCP clients are unsupported because CORS
is restricted to first-party origins. That does not apply here: MV3 background
fetches run under the extension's `host_permissions`, which exempts them from
CORS entirely. All alphaXiv traffic goes through the service worker
(`src/background/alphaxivMcp.ts`) — never a content script, never a page.

The `Origin` header does have to change, though. Chrome stamps
`Origin: chrome-extension://<id>` on every POST from the service worker, and
alphaXiv's auth server answers the token exchange with `403 Invalid origin`.
`Origin` is a forbidden header, so `fetch()` cannot touch it; `ensureOriginRule()`
in `src/background/alphaxivAuth.ts` installs a `declarativeNetRequest`
`modifyHeaders` rule that rewrites it on requests to `api.alphaxiv.org`.

Two things about the value took a while to pin down, both worth stating because
each one looks like the answer until you test it:

- **It rewrites rather than removes.** Dropping the header makes Chrome send
  `Origin: null` and the server answers `403 MISSING_OR_NULL_ORIGIN`. It accepts
  a request carrying no `Origin` at all, which is why a `curl` reproduction says
  everything is fine, but an extension `fetch` can never be that request. While
  the removing rule was installed `/oauth2/register` failed the same way, since
  `connect()` installs the rule before it registers.
- **The value is alphaXiv's web origin, not ours.** `403 Invalid origin` reads
  like it wants the client's registered redirect origin
  (`https://<id>.chromiumapp.org`), and `/oauth2/register` does accept that, but
  the token endpoint does not — its trusted list is just the first-party site.
  So `ALPHAXIV_TRUSTED_ORIGIN` is `https://www.alphaxiv.org` and the extension
  presents as their web app on this one header. Nothing here rides on a cookie
  and PKCE binds the exchange to this client, so the borrowed origin buys access
  to nothing the extension did not already have.

Two things about that rule are load-bearing. Its id must stay below
`FOCUS_DNR_ID_BASE` — focus mode deletes every dynamic rule at or above that
number when a session starts or ends. And it is installed from both `connect()`
and `getAccessToken()`, so an install that connected before the rule existed
picks it up on its next call rather than sitting broken.

Only registration and the authorize step survive the header, which is why this
failed at the very last hop of the sign-in and looked, from the outside, like a
rejected account.

## What the integration uses

| Surface | alphaXiv tool |
| --- | --- |
| Papers page → Find papers | `discover_papers` |
| PaperForm → Fetch (arXiv refs) | `get_paper_content` |
| Reader → Ask panel → alphaXiv source | `answer_pdf_queries` |
| Jarvis → `find_papers` / `read_paper` / `ask_paper` | the three above |
| Adding a paper / changing its status | `save_papers_to_folder`, `move_papers_between_folders`, `create_folder` |

Deliberately unused: `remove_papers_from_folder`, `delete_folder`,
`rename_folder`. Nothing this extension does can delete anything on alphaXiv.

## Troubleshooting

- **"Reconnect alphaXiv in Settings."** The refresh token was rejected — the
  grant was revoked or expired. Connect again.
- **"alphaXiv is rate-limiting sign-ups right now."** `/auth/oauth2/register`
  allows only a few registrations per IP per window. Wait a minute; the client
  id is cached once it succeeds, so this happens at most once per install.
- **"alphaXiv rejected the sign-in (HTTP 403: Invalid origin)."** or
  **`MISSING_OR_NULL_ORIGIN`.** The wrong `Origin` reached the token endpoint,
  which means the rule above was not applied or is still the old removing
  version. Check that dynamic rule id `ALPHAXIV_DNR_RULE_ID` is present
  (`chrome://extensions` → Reader → service worker → Console →
  `await chrome.declarativeNetRequest.getDynamicRules()`). Note that only a
  *valid* authorization code reaches this check — probing the token endpoint
  with a made-up code returns `invalid_grant` first and hides the problem, which
  is what made this take two rounds to find.
- **"alphaXiv refused to register this extension (HTTP …)."** The status and the
  server's own message are in the error. If it is a 403, mint a client id by
  hand and paste it into **Settings → alphaXiv**; a stored client id makes the
  extension skip registration entirely:

  ```sh
  curl -s -X POST https://api.alphaxiv.org/auth/oauth2/register \
    -H 'Content-Type: application/json' \
    -d '{"client_name":"Reader (Chrome extension)",
         "redirect_uris":["https://<EXTENSION_ID>.chromiumapp.org/"],
         "grant_types":["authorization_code","refresh_token"],
         "response_types":["code"],
         "token_endpoint_auth_method":"none",
         "scope":"openid profile email offline_access"}'
  ```

  The redirect URL must match this install's exactly — the failing error message
  prints it, and it is the only value alphaXiv validates the client against.
- **Rate limits.** Research tools run models server-side and count against your
  alphaXiv quota. Discovery is the expensive one; nothing in the extension calls
  it on a timer or in the background.
- **A paper alphaXiv can't open.** It resolves arXiv ids, arXiv/alphaXiv/
  Semantic Scholar pages, and direct PDF links. A `file://` PDF or a blob is not
  reachable, so those surfaces fall back to the local on-device path.
