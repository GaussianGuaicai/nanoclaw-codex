---
name: context-memory
description: Configure, verify, and troubleshoot NanoClaw structured session memory and sliding-window compaction. Use when enabling `~/.config/nanoclaw/context-config.json`, checking `context_turns` or `group_memory_state`, or debugging summary updates and bootstrap behavior.
---

# NanoClaw Context Memory

Use this skill when the user wants to enable, tune, verify, or debug the structured session memory pipeline.

## What This Covers

- Host-only config in `~/.config/nanoclaw/context-config.json`
- Structured YAML summaries per group
- `CONTEXT_BUNDLE` bootstrap for fresh sessions
- Sliding-window compaction and optional session restart

## Relevant Files

| File | Purpose |
|------|---------|
| `src/context-config.ts` | Loads and validates the host config |
| `src/context-runtime.ts` | Records turns, updates summaries, compacts sessions |
| `src/context-bootstrap.ts` | Builds the `CONTEXT_BUNDLE` prompt |
| `src/summary-memory.ts` | YAML schema and summary update prompt |
| `src/db.ts` | `context_turns` and `group_memory_state` tables |
| `docs/CONTEXT_MEMORY.md` | Canonical operator-facing guide |
| `groups/<group>/logs/worker-*.log` | Per-run worker logs |
| `logs/nanoclaw.log` | Host-side orchestration log |

## Workflow

1. Read `docs/CONTEXT_MEMORY.md` for the expected behavior and defaults.
2. Check `~/.config/nanoclaw/context-config.json`.
3. Confirm the relevant source is enabled for the task type:
   - `chat`
   - `scheduledGroupContext`
   - `websocketGroupContext`
   - `isolatedTasks`
4. Rebuild and restart NanoClaw after changing the config.
5. Verify a fresh turn writes to `context_turns` and updates `group_memory_state`.
6. If the session should bootstrap from scratch, confirm a `CONTEXT_BUNDLE` prompt was used.

## Typical Verification

```bash
sqlite3 store/messages.db \
  "SELECT group_folder, COUNT(*) AS turn_count, MAX(created_at) AS last_created_at FROM context_turns GROUP BY group_folder;"

sqlite3 store/messages.db \
  "SELECT group_folder, last_summarized_turn_id, last_compacted_turn_id, last_summary_at FROM group_memory_state;"
```

## Common Failure Modes

- The config file is missing or `enabled` is false, so the pipeline never starts.
- A session already exists, so bootstrap is skipped and `CONTEXT_BUNDLE` does not appear.
- Summary maintenance times out, leaving `last_summary_at` unchanged.
- Compaction thresholds are too high, so the window never advances.

## Output Expectations

When this feature is healthy, the host should:

- Write turns into SQLite
- Update the YAML summary after the configured turn threshold
- Compact old turns when token thresholds are exceeded
- Keep worker logs concise and factual
