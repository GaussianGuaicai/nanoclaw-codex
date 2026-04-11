---
name: add-imessage
description: Add iMessage as an optional channel skill for NanoClaw using a backend abstraction. Phase 1 implements local macOS polling and leaves a BlueBubbles seam.
---

# Add iMessage Channel

This skill adds **optional** iMessage support to NanoClaw-Codex. It follows the same skills-engine pattern as `add-slack`: the code lives in this skill package, is applied deterministically, self-registers through `registerChannel('imessage', ...)`, and does **not** become a core-bundled channel unless the skill is applied.

## What this skill changes

Applying the skill with the standard skills engine:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-imessage
```

will deterministically:

- Add `src/channels/imessage/` with a standard `imessage` channel implementation
- Add a backend interface plus two backends:
  - `local-macos` (**implemented**)
  - `bluebubbles` (**stub / seam only**)
- Append `import './imessage/index.js';` to `src/channels/index.ts`
- Add unit tests for the channel, normalization logic, checkpoint persistence, and the local backend
- Add these environment keys to `.env.example`:
  - `IMESSAGE_ENABLED`
  - `IMESSAGE_BACKEND`
  - `IMESSAGE_POLL_INTERVAL_MS`
  - `IMESSAGE_DB_PATH`
- Record the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read:

- `modify/src/channels/index.ts.intent.md`

## Files this skill adds when applied

- `src/channels/imessage/index.ts`
- `src/channels/imessage/channel.ts`
- `src/channels/imessage/backend.ts`
- `src/channels/imessage/backends/local-macos.ts`
- `src/channels/imessage/backends/bluebubbles.ts`
- `src/channels/imessage/local/chat-db.ts`
- `src/channels/imessage/local/applescript.ts`
- `src/channels/imessage/local/normalize.ts`
- `src/channels/imessage/local/checkpoint.ts`
- `src/channels/imessage/channel.test.ts`
- `src/channels/imessage/local/normalize.test.ts`
- `src/channels/imessage/local/checkpoint.test.ts`
- `src/channels/imessage/backends/local-macos.test.ts`

## Design constraints this skill follows

- The public channel name is always **`imessage`**
- The JID format is always **`imessage:<stable-chat-id>`**
- The stable chat ID is backend-independent so future migration from local macOS to BlueBubbles does not require changing:
  - channel name
  - JID prefix
  - `ownsJid()` behavior
  - host registration flow
- The channel remains a pure transport adapter:
  - inbound messages flow via `onMessage`
  - discovery metadata flows via `onChatMetadata`
  - agent / scheduler / context logic stays outside the channel

## Phase 1 scope

### Supported now

- macOS local iMessage **text receive**
- macOS local iMessage **text send**
- recent chat metadata sync
- checkpoint persistence using NanoClaw's existing DB-backed router state
- normal trigger/reply flow for registered chats

### Explicitly not included yet

- attachments
- rich text
- typing / read receipts / delivered state
- full group-chat feature completeness
- separate sidecar / daemon
- working BlueBubbles transport

## Environment and platform requirements

This skill currently requires:

- **macOS** host
- local access to the Messages SQLite database (default: `~/Library/Messages/chat.db`)
- permission for `osascript` / AppleScript to control **Messages.app** for outbound sends
- a signed-in iMessage account in Messages.app on the host Mac
- Full Disk Access for the process that launches NanoClaw (required on many macOS versions to read `chat.db`)

### Authentication parity checklist (match Slack's "fully connected" state)

iMessage has no bot token flow, so "auth complete" means all local macOS permissions are complete:

- Messages.app is signed in and can manually send to the target conversation
- NanoClaw launcher process has Full Disk Access (or startup can fail with `SQLITE_CANTOPEN` / `authorization denied`)
- AppleScript automation permission has been granted for controlling Messages.app
- target conversation is discovered in metadata sync and registered with `imessage:<stable-chat-id>`
- channel is enabled in runtime env (`IMESSAGE_ENABLED=true`, backend set to `local-macos`)

### Configuration

Add these values to `.env`:

```bash
IMESSAGE_ENABLED=true
IMESSAGE_BACKEND=local-macos
IMESSAGE_POLL_INTERVAL_MS=1500
IMESSAGE_DB_PATH=~/Library/Messages/chat.db
```

The current local-worker runtime reads `.env` from the host directly; there is no `data/env/env` sync step.
If you want iMessage enabled only for one group, prefer a group-scoped override in `~/.config/nanoclaw/group-secrets.json` instead of a global `.env` toggle.

## Behavior

- If `IMESSAGE_ENABLED` is not `true`, the factory returns `null`
- If the host platform is not macOS, the factory skips registration cleanly
- If the backend is `bluebubbles`, startup skips the channel and logs a clear **not implemented yet** message
- If `IMESSAGE_DB_PATH` is missing, startup skips the channel and logs a clear warning
- If `IMESSAGE_DB_PATH` points to a missing file, startup skips the channel and logs a clear warning
- Missing config must not crash the whole service; connection failures are logged clearly
- On first boot with no checkpoint, the local backend seeds checkpoint to the latest message row to avoid historical backfill storms
- Local chat DB queries use SQLite-compatible participant aggregation syntax across macOS SQLite variants

### Duplicate "已回复。" hardening

Older runtime builds could produce a duplicate visible follow-up in this pattern:

1. agent calls `nanoclaw/send_message` (immediate user-visible send)
2. same turn also emits a final assistant text
3. host auto-delivers the final text, causing a second short message like `已回复。`

Current fix is protocol-level (not phrase-based):

- runtime detects successful `nanoclaw/send_message` tool calls from Codex stream events
- when detected, final auto-delivery for that turn is suppressed
- this avoids channel-specific hardcoding in iMessage prompts or output text filters

Implementation reference:

- `container/agent-runner/src/runtime/codex-runtime.ts`

## Validation after apply

Run:

```bash
npx vitest run src/channels/imessage/channel.test.ts src/channels/imessage/local/normalize.test.ts src/channels/imessage/local/checkpoint.test.ts src/channels/imessage/backends/local-macos.test.ts
npm run build
```

Then restart and verify:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

For duplicate-send verification, send a test iMessage and confirm:

- only one outbound iMessage is sent for one inbound trigger
- worker log may include `mcp tool completed: nanoclaw/send_message`
- no second user-visible auto-reply is emitted for the same turn

## Registration and JID format

After the skill is applied and enabled, register chats using:

```text
imessage:<stable-chat-id>
```

Examples:

- `imessage:dm:+15551234567`
- `imessage:chat:chat1234567890`

The exact stable ID comes from the normalization layer so that the outward JID stays backend-agnostic.

## Future BlueBubbles integration seam

When adding BlueBubbles later, implement the transport in:

- `src/channels/imessage/backends/bluebubbles.ts`

without changing:

- `src/channels/imessage/channel.ts`
- `src/channels/imessage/index.ts`
- the `imessage:` JID contract
- how the host stores registered groups and metadata

## Related docs

- `IMESSAGE_SETUP.md` — operator/setup notes for local macOS permissions and validation
