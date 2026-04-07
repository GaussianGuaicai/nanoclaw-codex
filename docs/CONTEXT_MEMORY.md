# Context Memory

NanoClaw can keep a structured per-group session summary, refresh resumed sessions with durable memory, and compact old turns when context grows.

## Config File

The host-only config lives at:

```text
~/.config/nanoclaw/context-config.json
```

If the file is missing, NanoClaw uses defaults and keeps the whole pipeline off (`enabled: false`).

Example:

```json
{
  "enabled": true,
  "summaryMemory": {
    "enabled": true,
    "model": "gpt-5.4-mini",
    "reasoningEffort": "low",
    "updateMinTurns": 2,
    "maxItemsPerList": 12
  },
  "compaction": {
    "enabled": true,
    "strategy": "sliding-window",
    "trigger": {
      "lastInputTokensGte": 45000,
      "fallbackEstimatedTokensGte": 38000
    },
    "window": {
      "keepRecentTurns": 24,
      "keepRecentEstimatedTokens": 12000
    },
    "restartSessionAfterCompact": true
  },
  "sources": {
    "chat": true,
    "scheduledGroupContext": true,
    "websocketGroupContext": true,
    "isolatedTasks": false
  }
}
```

## Runtime Flow

- Chat and event-source turns are recorded after a successful response.
- When a group has no active session ID, NanoClaw prepends a `CONTEXT_BUNDLE` that contains the structured summary, a budgeted subset of relevant recent turns, and the current input.
- When a session ID already exists, NanoClaw resumes that session and prepends a lighter `MEMORY_REFRESH` block with the current structured summary plus any budgeted unsummarized turns for that source.
- After enough unsummarized turns, NanoClaw runs a maintenance worker to update the YAML summary.
- When compaction triggers, NanoClaw advances the compacted turn boundary and can clear the live session so the next turn cold-starts from a fresh `CONTEXT_BUNDLE`.
- Worker logs now surface `Bootstrap Used`, `Memory Refresh Used`, `Recent Turns Scope`, and `Recent Turn Count` to make verification easier.

## Storage

The summary pipeline writes to `store/messages.db`:

- `context_turns` stores user and assistant turns, token estimates, actual usage, and a batch ID
- `group_memory_state` stores the YAML summary plus the last summarized and compacted turn IDs
- `context_memory_events` stores a durable audit trail for summary updates and compaction runs, including the summary YAML before/after, delta turn IDs, compaction boundary changes, and whether the session was restarted
- `sessions` stores the current live Codex session IDs, scoped by chat or group event source

Detailed summary and compaction audit state lives in `context_memory_events`. Worker logs remain useful for bootstrap and refresh verification, but the audit table is the source of truth for what changed.

## Verification

1. Edit `~/.config/nanoclaw/context-config.json` and keep `enabled: true`.
2. Restart the NanoClaw launchd service.
3. Send a chat message or trigger a WebSocket event for a group that uses `contextMode: "group"`.
4. Check `store/messages.db` for `context_turns` and `group_memory_state`.
5. Inspect `context_memory_events` for the summary and compaction audit trail.
6. Inspect `groups/<group>/logs/worker-*.log` for the latest context summary lines:
   - fresh session: `Bootstrap Used: true`
   - resumed session: `Memory Refresh Used: true`
   - summary maintenance worker: context summary fields may be `unknown` because it is an internal maintenance prompt

Useful checks:

```bash
sqlite3 store/messages.db \
  "SELECT group_folder, last_summarized_turn_id, last_compacted_turn_id, last_summary_at FROM group_memory_state;"

sqlite3 store/messages.db \
  "SELECT group_folder, event_type, created_at FROM context_memory_events ORDER BY id DESC LIMIT 10;"

sqlite3 store/messages.db \
  "SELECT group_folder, session_id FROM sessions ORDER BY group_folder;"

tail -f logs/nanoclaw.log
tail -f groups/<group>/logs/worker-*.log
```

## Troubleshooting

- No rows appear in `context_turns`: the config file is missing, `enabled` is `false`, or the source is disabled.
- No `CONTEXT_BUNDLE` appears: the worker resumed an existing session instead of starting a fresh one, or compaction did not clear the live session yet.
- No `MEMORY_REFRESH` appears on a resumed run: the live session may already have been cleared by compaction, so the turn cold-started instead.
- Summary updates fail: check `logs/nanoclaw.log` for `Summary memory update failed`.
- Compaction does not trigger: the token threshold has not been reached yet.
- `Recent Turn Count` still looks too large: compare it against the number of eligible turns after `last_compacted_turn_id`; NanoClaw now selects a budgeted subset rather than replaying the full tail.

For a guided workflow, use the `$context-memory` skill.
