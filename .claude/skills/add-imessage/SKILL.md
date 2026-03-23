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

### Configuration

Add these values to `.env`:

```bash
IMESSAGE_ENABLED=true
IMESSAGE_BACKEND=local-macos
IMESSAGE_POLL_INTERVAL_MS=1500
IMESSAGE_DB_PATH=~/Library/Messages/chat.db
```

Then sync the environment into NanoClaw's runtime env file:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Behavior

- If `IMESSAGE_ENABLED` is not `true`, the factory returns `null`
- If the host platform is not macOS, the factory skips registration cleanly
- If the backend is `bluebubbles`, the channel keeps the same public semantics but logs a clear **not implemented yet** message
- Missing config must not crash the whole service; connection failures are logged clearly

## Validation after apply

Run:

```bash
npx vitest run src/channels/imessage/channel.test.ts src/channels/imessage/local/normalize.test.ts src/channels/imessage/local/checkpoint.test.ts src/channels/imessage/backends/local-macos.test.ts
npm run build
```

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
