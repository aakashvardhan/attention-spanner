# Brain dump reset: dump, reframe, lock

> **Status (2026-11-10): archived.** Written for the TypeScript extension, which the
> Rust port deleted (see `docs/superpowers/specs/2026-11-02-rust-port-design.md`), so most
> paths and code named here no longer exist. What shipped lives on in `rust/`; the README
> describes the current behaviour.

Date: 2026-10-29
Mockups: https://www.figma.com/design/mxN5zLYsFWhTgQ9c5iY5q4 (direction B, "Notebook", is chosen)

## Why

The brain dump is an exit ramp from rumination. When the user is stuck in a loop, the easy move is to escape (YouTube, scrolling, self-gratification) instead of writing. Two things block writing:

1. **Effort.** If starting takes more effort than escaping, escape wins. So the box has to be already open, the cursor already blinking, and nothing else in the way.
2. **Exposure to themselves.** Writing "I'm lost, behind at work, nowhere in my career" feels like admitting it. The reader they fear is themselves later, not another person. Haiku reading it is fine ("it's just an AI").

The payoff is relief: read a kinder version of what you wrote and feel lighter. It is not a task manager.

## Goals

- Typing can start the instant a new tab opens.
- Cmd+Enter sends the dump to Claude Haiku, which returns gently reframed bullet points.
- Raw text and bullets are locked together with encryption. Reading them back takes a deliberate unlock.
- Writing never needs the passphrase.

## Non-goals

- Tasks, next steps, priorities, progress, streaks, XP.
- Local models (Ollama, Laya) for the dump.
- Sync, export, or search across entries.
- Hiding entries from other people. The lock is friction against casual rereading, not a defense against an attacker with the unlocked page open.

## Anti-goals (a failure even if it works)

- Showing past raw dumps anywhere on the new tab.
- Asking for a passphrase before or during a dump (first-time setup comes *after* the first bullets).
- Losing a dump. Failure paths keep the text.
- Bullets that read as advice, a to-do list, or toxic positivity.

## What gets deleted

All of the current brain dump's behaviour goes (`src/pages/newtab/BrainDump.tsx`, `src/shared/brainDump.ts` and its tests are rewritten from scratch):

- Eisenhower sorting (`SORT_SYSTEM`, `QUADRANTS`, `parseBullets` quadrant parsing, `addBullets`, `bulletsOf`, `nextOpenBullet`)
- Next-step loops, retries, step-size checks (`NEXT_STEP_SYSTEM`, `stepProblem`, `retryPrompt`, `keepAfterRetries`, `MAX_STEP_TRIES`, `STEP_SIZE_QUESTION`, `isTooBig`, `hoursShare`)
- Recurring 1%-a-day practice (`DAILY_STEP_SYSTEM`, `RECURRING_QUESTION`, `isRecurring`, `isDue`, `doneToday`, `completeStep`)
- Laya classifiers (`FEELING_QUESTION`, `isOnlyFeeling`) and the Ollama path, warm-up, and `TraceRow`
- Done list, progress rings, check burst, "Next:" button, surfaced-on-its-own practice
- The "Parked (N)" list with Pick up / Delete
- Cloud-mode branching. The dump always uses Haiku (`CLAUDE_MODELS.quick`), regardless of `cloudMode`.

Kept: the in-memory draft (`draftMemo`) and the focus carry-over across remounts, `MAX_DUMP_CHARS` (4000), `claudeStream`, `askErrorMessage` (trimmed to Claude), the `Words` settle-in animation for bullets.

`Dump` in `src/shared/types.ts` shrinks to `{ id, text, createdAt }`; it is only used for dumps waiting for first-time setup.

## The card (new tab)

Matches direction B in the mockup. It stays a card on the Edition new tab (in `Dashboard.tsx`, same slot).

- Paper surface (`--bg-surface`-family tone), faint ruled lines (`--border`), standard card shadow and radius tokens. All CSS uses theme tokens (CI lint in `designSystem.test.ts`).
- Top line: lock icon + "Only Haiku reads this. Then it locks." in faint small text.
- Textarea drawn over the ruled lines; text in the display serif (`--font-display`); placeholder "Empty your head here" in italic, faint.
- Footer: lock icon + "N locked" (link to the entries page; hidden when N = 0), then the ⌘ ↵ keycaps + "when you are done".
- No buttons on the card.

### Focus

The textarea takes focus every time the new tab opens. Chrome gives the omnibox focus on override new tabs. The known workaround: when the new tab loads with the omnibox focused, it re-opens itself as a normal extension URL (`chrome.tabs.update(tabId, { url: chrome.runtime.getURL('src/pages/newtab/index.html#focus') })` or equivalent), which lets the page take focus. **Builder must verify this in real Chrome** (via `/verify`) and check it does not break back/forward or flash. If no workaround is clean, fall back to autofocus plus a note to the user; do not ship a flicker.

## Cmd+Enter flow

1. Empty or whitespace-only text: do nothing.
2. Send to Haiku: `claudeStream({ apiKey: settings.claudeKey, model: CLAUDE_MODELS.quick, system: REFRAME_SYSTEM, document: text, prompt: … })`, abortable, `ASK_TIMEOUT_MS` timeout.
3. While streaming, bullets appear one per ruled line, words settling in (`Words`). Above them: lock icon + "A little lighter. Locking away when you leave."
4. On success: raw text + bullets are encrypted as one entry (see Locking) immediately, before display ends. The draft is cleared. The bullets stay visible until the tab is closed or the page remounts; the next tab shows the empty card.
5. On failure (no key, offline, timeout, API error): text stays in the box, one muted line "Couldn't reach Haiku. Your words are still here." and the footer hint reads "try again". Cmd+Enter retries. If the page unloads (`pagehide`) with an unsent failed draft, it is locked raw with no bullets so it is never lost or left in plaintext. (If setup has not happened yet, it goes to the pending plaintext list instead; see below.)

### Reframe prompt (builder's call on wording, these are the rules)

- Output 2–6 bullets, one per line, plain text starting with "- ", no headers, no preamble.
- Faithful to what was written; no new facts.
- Gentle reframe: name feelings as feelings, not verdicts; shrink catastrophes to what is actually known.
- No advice, no tasks, no "you should", no exclamation marks, no cheerleading, no emojis.
- Example: "nowhere near in career" → "Career feels slow right now. That's a feeling, not a verdict."

Parse the reply into lines; drop empties; if nothing parses, treat as failure.

## Locking

### Crypto (builder's choices within these lines)

Web Crypto only, no new dependencies.

- One keypair per user: RSA-OAEP 3072 / SHA-256 (or ECDH P-256 + HKDF; builder picks, must allow encrypting with only the public key).
- Each entry: random AES-GCM 256 key encrypts JSON `{ text, bullets, createdAt }`; that key is wrapped with the public key.
- Private key (PKCS8) is stored twice, each encrypted with AES-GCM under a key from PBKDF2-SHA256 (≥ 600,000 iterations, random 16-byte salt):
  - once under the passphrase,
  - once under the recovery code.
- Recovery code: 128 random bits shown as groups (e.g. base32, `XXXX-XXXX-…`), shown once at setup.
- Storage (`chrome.storage.local`): `vault: { publicKey, byPassphrase: {salt, iv, data}, byRecovery: {salt, iv, data} } | null` and `lockedDumps: { id, createdAt, wrappedKey, iv, data }[]` (newest first). `createdAt` stays in the clear for ordering and the "N locked" count; text and bullets never do.
- Schema version bumps to 24; migration adds `vault: null`, `lockedDumps: []`, and strips old fields from existing `dumps` (keep only roots: entries without `parentId`; drop sorted points).

### First-time setup

Triggered after the first successful Cmd+Enter while `vault` is null:

1. Bullets show as usual.
2. Below them, in the same card: "Set a passphrase so this can lock." Passphrase + confirm fields.
3. Then the recovery code with "Write this down. It's the only way back in if you forget your passphrase." and a "I wrote it down" confirm.
4. On confirm: create the vault, encrypt the current dump and every pending plaintext dump in `dumps` (old dumps keep their `createdAt`, no bullets), write `lockedDumps`, then clear `dumps`. Order matters: write the locked entries before deleting the plaintext.

If the tab closes before setup finishes, the current dump is saved to `dumps` in plaintext and setup is offered again after the next Cmd+Enter. No passphrase, no lock: there is nothing else to do.

There is no passphrase change in this version (see Left to the builder).

## Entries page

A new extension page, `src/pages/dumps/index.html` (add to `vite.config.ts` inputs), opened from the card's "N locked" link. Not linked from anywhere else.

- **Locked:** lock icon, "Your dumps" in the display serif, "You chose to come here. Take your time.", passphrase field (Enter submits), "Use recovery code instead" link which swaps the field. Wrong secret: "That didn't unlock it." No lockout.
- **Unlocked:** header "Your dumps" + faint "Locks when you close this page". Entries newest first, each a paper card: date (relative), Delete, bullets in the display serif, then "Show what I wrote" which expands the raw text in a subtle box ("Hide what I wrote" to collapse). Entries with no bullets (old dumps, failed-and-closed ones) show the raw text behind the same toggle with "No bullets for this one."
- **Delete:** inline confirm ("Delete for good?" Delete / Keep), then remove from `lockedDumps`.
- **Re-lock:** the private key lives only in the page's memory (non-extractable `CryptoKey` after unwrap); closing or reloading the page drops it. Nothing is cached in storage or session storage.

## Constraints

- Read settings via `useSettings()`, never `useStorageValue('settings')`.
- CSS uses theme tokens only; motion uses existing spring tokens; never animate the display serif's font-weight.
- No emojis in UI copy.
- The Haiku API key is the existing `settings.claudeKey`. No key = the failure state on Cmd+Enter, with the message "Add a Claude key in Settings to get bullets. Your words are still here."

## Decided by the user

- Haiku is fine to receive dumps.
- Raw dump never shown back on the new tab; it goes into the locked section with its bullets.
- Bullets gently reframe; no actions; just read and feel lighter.
- Passphrase lock with a written-down recovery code.
- Card stays on the new tab, styled as direction B (notebook), and grabs the cursor on every new tab.
- Cmd+Enter submits.
- Separate entries page, bullets first, raw behind a click; locks when closed; entries can be deleted.
- Haiku failure keeps text in the card for retry.
- Old dumps are encrypted into the locked section at setup.
- Passphrase setup happens right after the first Cmd+Enter.

## My calls (flag if wrong)

- Public-key encryption so dumping never needs the passphrase.
- Failed draft is locked raw on tab close.
- First dump before setup waits in plaintext rather than being lost.
- Old sorted "points" are dropped; only the original dump text is kept.
- Bullets stay on screen until the tab closes, then the card is empty.
- No lockout after wrong passphrases.

## Left to the builder

- Exact reframe prompt wording, within the rules above.
- RSA-OAEP vs ECDH, base32 vs other recovery-code alphabet.
- The focus workaround's mechanism (and the fallback if none is clean).
- Whether the "lift and fly away" animation from the old card is reused for the lock moment.
- Passphrase change: out of scope for now; add later by unwrapping with the old secret and re-wrapping.
