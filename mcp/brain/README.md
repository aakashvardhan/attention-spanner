# Vault MCP server and brain tools

Lets Claude Code read and edit the second-brain vault (spec: docs/superpowers/specs/2026-10-14-second-brain-design.md, "Vault MCP server").

## Set up (Mac)

1. Build: `npm run build:mcp` (also part of `npm run build`).
2. Point it at the vault, in your shell profile: `export BRAIN_VAULT="$HOME/Library/CloudStorage/GoogleDrive-<account>/My Drive/brain"`.
3. Restart Claude Code in this repo and approve the `brain` server from `.mcp.json` when asked. `/mcp` should show it connected.

## Tools

- Read, no prompt: `search` (Obsidian syntax), `read_note`, `backlinks`, `list_moc`, `list_folder`.
- Write, Claude Code asks each time: `daily_note`, `create_note`, `write_note`, `edit_note`, `rename_note`, `move_note`, `delete_note`.
- Import: `stage_note`, `stage_attachment`, and `promote_staging`, which needs a passing fidelity audit for exactly what is staged.

## Safety

- Writes go to a temporary file that is then renamed into place, so a crash never leaves half a note.
- Every write tool copies the old file into `.brain/history/<date>/` first. Copies are kept 7 days.
- Rename, move, delete and promote run through a journal in `.brain/journal/`, which finishes them after a crash.
- The server never writes `sources/` (except when promoting), `.obsidian/`, or `.brain/` outside its own folders.
- `edit_note` and `write_note` refuse a note that changed since Claude last read it.
- Every write is logged to `.brain/mcp-log.jsonl`.

## Local tools

`node dist-mcp/cli.mjs <command>` runs these:

- `usage`, `notion-links`, `cards`, `recall`, `tree-test`, `baseline`: the step 0 baseline
- `drive-probe`: the step 1 platform measurements
- `diff-obsidian`: our index against Obsidian's own

They write only to `<vault>/.brain/reports/`, and `drive-probe` its probe files to `<vault>/.brain/probe/`.
