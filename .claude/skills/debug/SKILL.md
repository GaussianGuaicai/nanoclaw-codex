---
name: debug
description: Debug NanoClaw runtime issues. Use when worker runs fail, channel auth breaks, context memory behaves unexpectedly, WebSocket sources stop, or to inspect logs, IPC, sessions, and sandbox layout.
---

# NanoClaw Debugging

This guide covers the current NanoClaw runtime: a host-side Node.js service that launches a local Codex worker with group-scoped sandbox roots and per-group `CODEX_HOME`.

Start with the repo docs that already match the current architecture:
- `docs/DEBUG_CHECKLIST.md` for fast operational triage
- `docs/CONTEXT_MEMORY.md` for session summary, `CONTEXT_BUNDLE`, `MEMORY_REFRESH`, and compaction checks
- `docs/SECURITY.md` for sandbox and writable-root behavior

## Runtime map

```
Host service
  src/index.ts
  src/container-runner.ts
    │
    ├── prepares sandbox layout and writable roots
    ├── sets per-group CODEX_HOME in data/sessions/{group}/.codex
    ├── exposes IPC snapshots under data/ipc/{group}/
    └── launches local Codex worker
            │
            └── writes per-run logs to groups/{group}/logs/worker-*.log
```

## High-signal locations

| What | Where |
|-----|-----|
| Service log | `logs/nanoclaw.log` |
| Service stderr | `logs/nanoclaw.error.log` |
| Per-run worker log | `groups/{group}/logs/worker-*.log` |
| SQLite state | `store/messages.db` |
| Per-group Codex state | `data/sessions/{group}/.codex` |
| IPC snapshots | `data/ipc/{group}/current_tasks.json`, `data/ipc/{group}/available_groups.json` |
| WebSocket event logs | `logs/websocket-events-<provider>.log` |

## Fast triage flow

### 1. Confirm service health

```bash
launchctl list | grep nanoclaw
ls -la container/agent-runner/dist/index.js
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20
```

If the worker build is missing, run:

```bash
npm run build
```

### 2. Check whether work is reaching the worker

```bash
grep -E 'Processing messages|Spawning local Codex worker|Starting worker' logs/nanoclaw.log | tail -10
grep -E 'Worker active|Starting worker|concurrency limit' logs/nanoclaw.log | tail -10
ls -lt groups/*/logs/worker-*.log | head -10
```

If worker logs exist, open the newest matching file first. It usually contains the exact runtime layout, prompt summary, tool trace, and terminal trace needed to debug the failure.

### 3. Inspect session and memory state

```bash
sqlite3 store/messages.db "SELECT group_folder, session_id FROM sessions ORDER BY group_folder;"
sqlite3 store/messages.db "SELECT group_folder, last_summarized_turn_id, last_compacted_turn_id, last_summary_at, last_compaction_at FROM group_memory_state ORDER BY group_folder;"
```

For context-memory issues, inspect the matching worker log for:
- `Session ID`
- `Bootstrap Used`
- `Memory Refresh Used`
- `Recent Turns Scope`
- `Recent Turn Count`

Use `docs/CONTEXT_MEMORY.md` to decide whether the run was supposed to cold-start or resume.

### 4. Check IPC and task state

```bash
find data/ipc -maxdepth 2 -type f | sort
cat data/ipc/<group>/current_tasks.json
cat data/ipc/<group>/available_groups.json
```

Use this when scheduled tasks, `send_message`, or group visibility looks wrong.

### 5. Check channel or event-source health

```bash
grep -E 'Connected to WhatsApp|Connection closed|connection.*close' logs/nanoclaw.log | tail -5
ls -1 logs | grep 'websocket-events'
grep -E 'WS socket opened|subscriptions active|unsupported WS provider' logs/nanoclaw.log | tail -20
```

## Common problems

### Worker exits or times out

Check:

```bash
grep -E 'Worker timed out|timed out' logs/nanoclaw.log | tail -10
cat groups/<group>/logs/worker-<timestamp>.log
```

Usual causes:
- worker build is stale or missing
- prompt or tool run exceeded timeout
- sandbox layout rejected a writable root
- downstream auth or MCP configuration failed

### Agent stops responding to new messages

Check:

```bash
grep 'New messages' logs/nanoclaw.log | tail -10
grep -E 'Processing messages|Spawning local Codex worker|Starting worker' logs/nanoclaw.log | tail -10
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) AS latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

If messages arrive but workers do not start, inspect queue and retry logs before changing code.

### Session did not resume

Check:

```bash
sqlite3 store/messages.db "SELECT group_folder, session_id FROM sessions WHERE group_folder LIKE '%<group>%';"
grep -E 'Session ID|Bootstrap Used|Memory Refresh Used' groups/<group>/logs/worker-<timestamp>.log
```

Interpretation:
- `Session ID: new` with `Bootstrap Used: true` means a cold start
- `Memory Refresh Used: true` means a resumed session received fresh durable memory
- If a session disappeared after compaction, that can be expected behavior rather than a bug

Also verify that `data/sessions/{group}/.codex` exists and is writable.

### Writable roots or snapshot mapping looks wrong

Check:

```bash
grep -E 'Mount validated|Mount.*REJECTED|layout|writableRoots|additionalDirectories' logs/nanoclaw.log | tail -20
cat ~/.config/nanoclaw/mount-allowlist.json
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"
grep -n 'Runtime Layout' -A40 groups/<group>/logs/worker-<timestamp>.log
```

`containerConfig` is still a compatibility input, but it now maps to sandbox writable roots or read-only snapshots rather than container mounts.

### WhatsApp auth problems

Check:

```bash
grep 'QR\\|authentication required\\|qr' logs/nanoclaw.log | tail -5
ls -la store/auth/
```

If auth is missing or expired, re-run the relevant channel setup/auth flow.

## Safe cleanup moves

Only do these when the user explicitly wants reset behavior:

```bash
# Clear tracked session IDs only
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '<group>';"

# Remove per-group Codex state
rm -rf data/sessions/<group>/.codex
```

If the issue is context memory rather than live session state, do not delete state blindly. Inspect `group_memory_state` and recent `worker-*.log` files first.

## Output expectations

When using this skill, report:
- what path is failing: service, channel, worker, session memory, IPC, or outbound delivery
- the smallest concrete artifact that proves it: one log line, one DB row, or one worker-log field
- whether the next action is configuration, code fix, rebuild, restart, or reset
