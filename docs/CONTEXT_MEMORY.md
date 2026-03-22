# Context Memory

NanoClaw can keep a structured per-group session summary and compact old turns when context grows.

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
- When a group has no active session ID, NanoClaw prepends a `CONTEXT_BUNDLE` that contains the structured summary, recent turns, and the current input.
- When a session ID already exists, NanoClaw resumes that session and skips the bootstrap bundle.
- After enough unsummarized turns, NanoClaw runs a maintenance worker to update the YAML summary.
- When compaction triggers, NanoClaw advances the compacted turn boundary and can restart the session to keep the active context short.

## Storage

The summary pipeline writes to `store/messages.db`:

- `context_turns` stores user and assistant turns, token estimates, actual usage, and a batch ID
- `group_memory_state` stores the YAML summary plus the last summarized and compacted turn IDs

## Verification

1. Edit `~/.config/nanoclaw/context-config.json` and keep `enabled: true`.
2. Restart the NanoClaw launchd service.
3. Send a chat message or trigger a WebSocket event for a group that uses `contextMode: "group"`.
4. Check `store/messages.db` for `context_turns` and `group_memory_state`.
5. Inspect `groups/<group>/logs/worker-*.log` for the summary maintenance run.

Useful checks:

```bash
sqlite3 store/messages.db \
  "SELECT group_folder, last_summarized_turn_id, last_compacted_turn_id, last_summary_at FROM group_memory_state;"

tail -f logs/nanoclaw.log
tail -f groups/<group>/logs/worker-*.log
```

## Troubleshooting

- No rows appear in `context_turns`: the config file is missing, `enabled` is `false`, or the source is disabled.
- No `CONTEXT_BUNDLE` appears: the worker resumed an existing session instead of starting a fresh one.
- Summary updates fail: check `logs/nanoclaw.log` for `Summary memory update failed`.
- Compaction does not trigger: the token threshold has not been reached yet.

For a guided workflow, use the `/context-memory` skill.
