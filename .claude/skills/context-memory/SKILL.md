---
name: context-memory
description: Configure, verify, and troubleshoot NanoClaw structured session memory, `MEMORY_REFRESH`, and sliding-window compaction. Use when enabling `~/.config/nanoclaw/context-config.json`, checking `context_turns` or `group_memory_state`, or debugging summary updates, bootstrap behavior, and resumed-session refreshes.
---

# NanoClaw Context Memory

Use this skill when the user wants to enable, tune, verify, or debug the structured session memory pipeline.

## What This Covers

- Host-only config in `~/.config/nanoclaw/context-config.json`
- Structured YAML summaries per group
- `CONTEXT_BUNDLE` bootstrap for fresh sessions
- `MEMORY_REFRESH` for resumed sessions
- Budgeted recent-turn selection for fresh and resumed prompts
- Sliding-window compaction and optional session restart

## Relevant Files

| File | Purpose |
|------|---------|
| `src/context-config.ts` | Loads and validates the host config |
| `src/context-runtime.ts` | Records turns, updates summaries, compacts sessions |
| `src/context-bootstrap.ts` | Builds `CONTEXT_BUNDLE` and `MEMORY_REFRESH` prompts |
| `src/context-selection.ts` | Selects a budgeted subset of recent turns for prompt injection |
| `src/summary-memory.ts` | YAML schema and summary update prompt |
| `src/db.ts` | `context_turns`, `group_memory_state`, and `sessions` tables |
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
7. If the session should resume, confirm `MEMORY_REFRESH` appears in the worker log instead of a full bootstrap.

## Typical Verification

```bash
sqlite3 store/messages.db \
  "SELECT group_folder, COUNT(*) AS turn_count, MAX(created_at) AS last_created_at FROM context_turns GROUP BY group_folder;"

sqlite3 store/messages.db \
  "SELECT group_folder, last_summarized_turn_id, last_compacted_turn_id, last_summary_at FROM group_memory_state;"

sqlite3 store/messages.db \
  "SELECT group_folder, session_id FROM sessions ORDER BY group_folder;"
```

## Common Failure Modes

- The config file is missing or `enabled` is false, so the pipeline never starts.
- A session already exists, so bootstrap is skipped and `CONTEXT_BUNDLE` does not appear.
- Compaction cleared the session, so a turn you expected to resume instead cold-started with `CONTEXT_BUNDLE`.
- A resumed turn is missing `MEMORY_REFRESH`, so the session likely was not actually resumed.
- Summary maintenance times out, leaving `last_summary_at` unchanged.
- Compaction thresholds are too high, so the window never advances.

## Output Expectations

When this feature is healthy, the host should:

- Write turns into SQLite
- Update the YAML summary after the configured turn threshold
- Refresh resumed sessions with the current summary and a budgeted recent-turn subset
- Compact old turns when token thresholds are exceeded
- Keep worker logs concise, factual, and explicit about bootstrap vs refresh
