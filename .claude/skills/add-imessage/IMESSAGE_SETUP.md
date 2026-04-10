# iMessage Setup for NanoClaw

This optional skill currently supports only the **local macOS backend**.

## Requirements

- macOS host running Messages.app
- The same macOS user account that runs NanoClaw must have access to `~/Library/Messages/chat.db`
- Messages.app must be signed into iMessage
- Automation permission may be required so `osascript` can tell Messages.app to send outgoing text

## Recommended `.env`

```bash
IMESSAGE_ENABLED=true
IMESSAGE_BACKEND=local-macos
IMESSAGE_POLL_INTERVAL_MS=1500
IMESSAGE_DB_PATH=~/Library/Messages/chat.db
```

The current local-worker runtime reads `.env` from the host directly; do not sync `.env` into `data/env/env`.
If you only want iMessage for one group, use a group-scoped `workerEnv` override in `~/.config/nanoclaw/group-secrets.json` instead of enabling it globally.

## Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## What to expect

- The channel name is always `imessage`
- Registered JIDs always start with `imessage:`
- On startup, the local backend syncs recent chats as metadata
- On first boot, checkpoint is seeded to the latest message row to avoid importing full history
- Polling then imports new inbound text messages while persisting a checkpoint to NanoClaw's DB-backed router state

## If sending fails

Common causes:

- Messages.app is not signed in
- AppleScript automation permission was denied
- the target chat has not been discovered yet and cannot be resolved from the stable ID
- the stable chat ID maps to a group conversation AppleScript cannot address with the current minimal backend

## Current limitations

- text only
- no attachments
- no rich text
- no typing/read state
- no production BlueBubbles backend yet
