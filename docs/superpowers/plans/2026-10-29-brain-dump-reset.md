# Brain Dump Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the task-engine brain dump with: type on a notebook card, Cmd+Enter, Haiku returns gently reframed bullets, raw + bullets are encrypted into a passphrase-locked entries page.

**Architecture:** Pure crypto in `src/shared/vault.ts` (Web Crypto, public-key so writing never needs the passphrase). Pure prompt/parse helpers in `src/shared/brainDump.ts`. The new-tab card (`BrainDump.tsx`) streams Haiku via the existing `claudeStream`, then seals the entry; first-time setup lives in the card. A new extension page `src/pages/dumps/` unlocks and lists entries; the private key exists only in that page's memory.

**Tech Stack:** React 18, TypeScript, Vite + CRXJS (MV3), Vitest (Node 25, `globalThis.crypto.subtle` available), Playwright via `/verify`.

**Spec:** `docs/superpowers/specs/2026-10-29-brain-dump-reset-design.md`
**Mockups:** https://www.figma.com/design/mxN5zLYsFWhTgQ9c5iY5q4 (direction B, "Notebook")

## Global Constraints

- Web Crypto only, no new dependencies.
- PBKDF2-SHA256, ≥ 600,000 iterations, random 16-byte salt; AES-GCM 256 per entry; private key stored twice (passphrase, recovery code).
- Recovery code: 128 random bits, base32 groups `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` (26 chars of base32 padded/grouped in 4s; exact grouping is the builder's call but must round-trip through `normalizeRecoveryCode`).
- Haiku only: `CLAUDE_MODELS.quick`, `settings.claudeKey`, ignore `cloudMode`. Timeout `ASK_TIMEOUT_MS` = 60,000.
- `MAX_DUMP_CHARS` = 4000.
- Schema version 24.
- Read settings via `useSettings()`, never `useStorageValue('settings')`.
- CSS uses theme tokens only (`designSystem.test.ts` lint); motion uses spring tokens; never animate `--font-display` font-weight.
- No emojis in UI copy. Copy strings below are verbatim from the spec.
- Never show past raw dumps on the new tab.

## Review Focus

1. Haiku replies with a preamble line, `*`/`•`/`1.` bullets, or blank lines: bullets still parse, preamble is dropped (test in Task 2).
2. Wrong passphrase or recovery code: a clear "That didn't unlock it." not a crash (test in Task 1, UI in Task 5).
3. Recovery code typed lowercase, without dashes, or with spaces: still unlocks (test in Task 1).
4. A 4000-char dump with emoji, quotes and newlines survives seal/open byte-for-byte (test in Task 1).
5. Cmd+Enter pressed again while Haiku is streaming, or during setup: no second request, no duplicate entry (guard in Task 4, checked in its `/verify` step).

---

### Task 1: Vault crypto

**Files:**
- Create: `src/shared/vault.ts`
- Create: `src/shared/vault.test.ts`
- Modify: `src/shared/types.ts` (add types below next to `Dump`)

**Interfaces:**
- Produces (types in `types.ts`):
  - `interface Sealed { salt?: string; iv: string; data: string }` (base64 strings)
  - `interface Vault { publicKey: JsonWebKey; byPassphrase: Sealed; byRecovery: Sealed }`
  - `interface LockedDump { id: string; createdAt: number; wrappedKey: string; iv: string; data: string }`
  - `interface DumpEntry { text: string; bullets: string[]; createdAt: number }`
- Produces (`vault.ts`):
  - `createVault(passphrase: string): Promise<{ vault: Vault; recoveryCode: string }>`
  - `sealEntry(publicKey: JsonWebKey, entry: DumpEntry, id?: string): Promise<LockedDump>`
  - `sealPending(publicKey: JsonWebKey, pending: readonly Dump[], current?: DumpEntry): Promise<LockedDump[]>` — pending become entries with `bullets: []`, keep `createdAt` and `id`; result newest first.
  - `unlockVault(vault: Vault, secret: string, via: 'passphrase' | 'recovery'): Promise<CryptoKey>` — non-extractable private key; throws `VaultLockedError` on a wrong secret.
  - `openEntry(privateKey: CryptoKey, locked: LockedDump): Promise<DumpEntry>`
  - `class VaultLockedError extends Error`
  - `normalizeRecoveryCode(input: string): string` — uppercase, strip spaces and dashes.

- [ ] **Step 1: Write the failing tests** in `vault.test.ts`:
  - `round-trips an entry`: `createVault('correct horse')` → `sealEntry(vault.publicKey, entry)` → `unlockVault(vault, 'correct horse', 'passphrase')` → `openEntry` equals `entry`.
  - `round-trips 4000 chars of mixed text`: text = `'é "quote"\n🙂'` repeated to exactly 4000 chars; bullets `['a', 'b']`; result `toEqual` input.
  - `unlocks with the recovery code in any casing or spacing`: `unlockVault(vault, recoveryCode.toLowerCase().replace(/-/g, ' '), 'recovery')` opens the entry.
  - `rejects a wrong passphrase`: `await expect(unlockVault(vault, 'nope', 'passphrase')).rejects.toBeInstanceOf(VaultLockedError)`; same for a wrong recovery code.
  - `seals pending dumps with their dates`: `sealPending(pk, [{id:'old',text:'x',createdAt:1}], {text:'y',bullets:['b'],createdAt:5})` → length 2, `[0].createdAt === 5`, `[1].id === 'old'`, opened `[1]` has `bullets: []`.
  - `stores no plaintext`: `JSON.stringify(locked)` does not contain the entry text; `JSON.stringify(vault)` does not contain the passphrase.
  - `uses enough PBKDF2 iterations`: `expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000)` (exported constant; the real count is used everywhere, so these tests take ~1 s each, which is fine).

- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/shared/vault.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `vault.ts`**
  RSA-OAEP 3072 / SHA-256 keypair (`generateKey(..., true, ['encrypt','decrypt'])`); per entry a fresh AES-GCM key, `wrapKey('raw', ...)` with the public key; private key exported PKCS8 and AES-GCM-encrypted under PBKDF2-derived keys; on unlock import it with `extractable: false`. Any `OperationError` during unlock becomes `VaultLockedError`. Base64 via `btoa`/`atob` over byte strings.

- [ ] **Step 4: Run to verify they pass**
  Run: `npx vitest run src/shared/vault.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**
  `git add src/shared/vault.ts src/shared/vault.test.ts src/shared/types.ts && git commit -m "Vault: public-key sealed dump entries"`

---

### Task 2: Reframe prompt and parsing (replaces old brainDump.ts)

**Files:**
- Rewrite: `src/shared/brainDump.ts`
- Rewrite: `src/shared/brainDump.test.ts`

**Interfaces:**
- Produces:
  - `MAX_DUMP_CHARS = 4000`, `ASK_TIMEOUT_MS = 60_000`
  - `REFRAME_SYSTEM: string` — the rules from the spec's "Reframe prompt" section (2–6 bullets, `- ` prefix, faithful, feelings not verdicts, no advice/tasks/"you should"/exclamation marks/cheerleading/emojis, includes the career example).
  - `parseReframe(reply: string): string[]`
  - `askErrorMessage(err: unknown, timedOut: boolean): string`
  - `NO_KEY_MESSAGE = "Add a Claude key in Settings to get bullets. Your words are still here."`
  - `FAILED_MESSAGE = "Couldn't reach Haiku. Your words are still here."`

- [ ] **Step 1: Write the failing tests**
  - `parseReframe('- a\n- b')` → `['a','b']`
  - `parseReframe('Here is a lighter version:\n\n* a\n• b\n1. c\n')` → `['a','b','c']`
  - `parseReframe('just prose with no bullets')` → `[]`
  - `parseReframe` caps at 6 items.
  - `askErrorMessage(new Error('x'), true)` === `FAILED_MESSAGE`; `askErrorMessage(new TypeError('bug'), false)` === `FAILED_MESSAGE`.
  - `REFRAME_SYSTEM` contains `'- '` and does not contain `'Eisenhower'`.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/shared/brainDump.test.ts`, FAIL.

- [ ] **Step 3: Implement.** Delete every old export (list in the spec's "What gets deleted"). A line counts as a bullet if it matches `/^\s*(?:[-*•]|\d+[.)])\s+(.+)/`; everything else is dropped. Error messages are calm and fixed; do not surface raw API text.

- [ ] **Step 4: Run to verify they pass** — PASS. Then `npx tsc --noEmit` will fail in `BrainDump.tsx`; that is fixed in Task 4. Do not commit until Step 5.

- [ ] **Step 5: Commit** (with Task 3, since types and callers move together) — skip here.

---

### Task 3: Storage v24

**Files:**
- Modify: `src/shared/types.ts:322-340` (`Dump` → `{ id: string; text: string; createdAt: number }`; delete `Quadrant`)
- Modify: `src/shared/storage.ts` (schema keys, defaults, migration)
- Modify: `src/shared/storage.test.ts`

**Interfaces:**
- Consumes: `Vault`, `LockedDump` (Task 1).
- Produces: `StorageSchema.vault: Vault | null` (default `null`), `StorageSchema.lockedDumps: LockedDump[]` (default `[]`, newest first), `StorageSchema.dumps: Dump[]` now means "waiting for first-time setup". Exported pure `v24Dumps(list: readonly unknown[]): Dump[]`.

- [ ] **Step 1: Write the failing test** `v24Dumps` keeps roots only and strips fields:
  input `[{id:'r',text:'raw',createdAt:1,nextStep:'s',kind:'task'},{id:'p',text:'point',createdAt:2,parentId:'r',quadrant:'do'}]` → `[{id:'r',text:'raw',createdAt:1}]`.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/shared/storage.test.ts`, FAIL.

- [ ] **Step 3: Implement.** Add the two keys + defaults; in `migrate()` change the guard and final write to 24 and add `if (version < 24) await chrome.storage.local.set({ dumps: v24Dumps(stored.dumps ?? []) })`. Update the `dumps` doc comment.

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit** Tasks 2 + 3 together after Task 4 compiles (see Task 4 Step 6).

---

### Task 4: The notebook card and first-time setup

**Files:**
- Rewrite: `src/pages/newtab/BrainDump.tsx`
- Create: `src/pages/newtab/VaultSetup.tsx`
- Modify: `src/pages/newtab/newtab.css` (replace all `.edition-dump*` and `.dump-*` rules with `.notebook-*` rules)
- Modify: `src/shared/ambient.test.ts:14` (remove the `BrainDump.tsx` entry; the new card does not call `requestAnimationFrame`)
- Modify: `src/pages/newtab/main.tsx` (focus workaround)

**Interfaces:**
- Consumes: `sealEntry`, `sealPending`, `createVault` (Task 1); `REFRAME_SYSTEM`, `parseReframe`, `askErrorMessage`, `NO_KEY_MESSAGE`, `MAX_DUMP_CHARS`, `ASK_TIMEOUT_MS` (Task 2); `vault`, `lockedDumps`, `dumps` keys (Task 3); `claudeStream`, `CLAUDE_MODELS.quick`, `useSettings`, `useStorageValue`, `setLocal`.
- Produces: `<BrainDump />` (same export, same slot in `Dashboard.tsx:260`); `<VaultSetup current: DumpEntry; onDone: () => void />`.

Behaviour (spec sections "The card", "Cmd+Enter flow", "First-time setup"):
- Card states: `writing` | `streaming` | `bullets` | `setup` | `failed`. Cmd+Enter is ignored unless state is `writing` or `failed` and the trimmed text is non-empty (Review Focus 5).
- Copy, verbatim: top line `Only Haiku reads this. Then it locks.`; placeholder `Empty your head here`; footer `N locked` (link to `chrome.runtime.getURL('src/pages/dumps/index.html')`, hidden at 0), keycaps `⌘ ↵` + `when you are done` (`try again` in `failed`); bullets header `A little lighter. Locking away when you leave.`
- On success with a vault: `sealEntry` then prepend to `lockedDumps`, clear the draft, show bullets with `Words`.
- On success without a vault: show bullets, then `VaultSetup`: `Set a passphrase so this can lock.` (passphrase + confirm, must match, non-empty) → recovery code with `Write this down. It's the only way back in if you forget your passphrase.` and an `I wrote it down` button → `createVault`, `sealPending(pk, dumps, current)`, write `vault` and `lockedDumps` in one `setLocal` call, then `setLocal('dumps', [])`.
- If the page hides (`pagehide`) during `setup` or before it, push the current entry's raw text to `dumps` as a `Dump`. If it hides in `failed` with a vault, `sealEntry` with `bullets: []`; without a vault, push to `dumps`.
- Keep `draftMemo` / `draftFocused` remount behaviour from the old file.
- Textarea `maxLength={MAX_DUMP_CHARS}`.
- Focus: in `main.tsx`, if the page loaded as the new-tab override and `document.hasFocus()` is false, `chrome.tabs.getCurrent` → `chrome.tabs.update(tab.id, { url: chrome.runtime.getURL('src/pages/newtab/index.html') })` once (guard with a `?f` query param so it never loops). Then `inputRef.current.focus()` on mount.

- [ ] **Step 1: Implement `VaultSetup.tsx` and the new `BrainDump.tsx`, replace the CSS.** Notebook look from the mockup: paper card, ruled lines via a repeating-linear-gradient on the textarea (line height = `--leading-read`), display serif for text, faint lock icon (reuse `Icon.tsx` if it has a lock, else add a `lock` glyph there).

- [ ] **Step 2: Typecheck and unit tests**
  Run: `npm run typecheck && npm test` — Expected: PASS (includes `designSystem.test.ts`, `motion.test.ts`, `ambient.test.ts`).

- [ ] **Step 3: Verify in Chrome with `/verify`.** Stub Haiku by leaving `claudeKey` empty for the failure path, then set a real key. Check, with screenshots:
  - New tab opens with the cursor in the card (and no visible reload flash). If the workaround flashes or breaks back/forward, remove it and keep plain autofocus; note this in the commit message.
  - Empty Cmd+Enter does nothing.
  - No key: text stays, `Add a Claude key in Settings to get bullets. Your words are still here.`
  - With a key: bullets stream one per line; pressing Cmd+Enter again during streaming sends nothing (one request in the network log).
  - First run shows setup; after `I wrote it down`, `chrome.storage.local` has `vault`, `lockedDumps` length = previous `dumps` + 1, and `dumps` is `[]`.
  - Next new tab: empty card, `N locked` shows the right count.

- [ ] **Step 4: Commit Tasks 2–4**
  `git add src/shared/brainDump.ts src/shared/brainDump.test.ts src/shared/types.ts src/shared/storage.ts src/shared/storage.test.ts src/shared/ambient.test.ts src/pages/newtab/BrainDump.tsx src/pages/newtab/VaultSetup.tsx src/pages/newtab/newtab.css src/pages/newtab/main.tsx && git commit -m "Brain dump: notebook card, Haiku reframe, sealed entries"`

---

### Task 5: Entries page

**Files:**
- Create: `src/pages/dumps/index.html`, `src/pages/dumps/main.tsx`, `src/pages/dumps/Dumps.tsx`, `src/pages/dumps/dumps.css` (mirror `src/pages/papers/` scaffolding)
- Modify: `vite.config.ts:37-43` (add `dumps: 'src/pages/dumps/index.html'`)

**Interfaces:**
- Consumes: `unlockVault`, `openEntry`, `VaultLockedError`, `normalizeRecoveryCode` (Task 1); `vault`, `lockedDumps` keys (Task 3); `formatRelativeDate`.
- Produces: the page at `src/pages/dumps/index.html`, linked from the card.

Behaviour (spec "Entries page"), copy verbatim:
- Locked: lock icon, `Your dumps`, `You chose to come here. Take your time.`, passphrase field (Enter submits), `Use recovery code instead` / back link swaps the field and the `via` argument. `VaultLockedError` → `That didn't unlock it.` No lockout. No vault yet → `Nothing locked yet.`
- Unlocked: header `Your dumps` + `Locks when you close this page`; entries newest first; each: relative date, `Delete`, bullets in the display serif, `Show what I wrote` / `Hide what I wrote` toggling the raw text; no bullets → `No bullets for this one.` above the toggle.
- Delete: inline `Delete for good?` with `Delete` / `Keep`; remove by `id` from `lockedDumps`.
- Private key held only in React state; nothing written to storage on unlock.

- [ ] **Step 1: Implement the page and the vite input.**

- [ ] **Step 2: Typecheck and tests** — `npm run typecheck && npm test`, PASS.

- [ ] **Step 3: Verify with `/verify`:** open via the card's `N locked` link; wrong passphrase shows `That didn't unlock it.`; right passphrase lists entries bullets-first; lowercase recovery code with spaces unlocks; `Show what I wrote` reveals raw text; delete-confirm removes one entry (count drops on the card); reload returns to the locked screen.

- [ ] **Step 4: Commit**
  `git add src/pages/dumps vite.config.ts && git commit -m "Entries page: unlock, read bullets first, delete"`

---

### Task 6: Final sweep

- [ ] **Step 1:** `grep -rn "nextStep\|Quadrant\|SORT_SYSTEM\|parkDump\|bulletsOf\|edition-dump\|dump-ring" src e2e` — Expected: no matches.
- [ ] **Step 2:** `npm run build && npm test` — Expected: PASS.
- [ ] **Step 3:** Commit any leftovers: `git commit -m "Remove last brain dump task-engine references"` (skip if nothing changed).
