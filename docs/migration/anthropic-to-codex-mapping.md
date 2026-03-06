# Anthropic Agent SDK → Codex SDK Mapping (Phase 1)

This document records the migration surface from NanoClaw's current Anthropic runtime to a future Codex runtime.

## Status legend

- ✅ direct or near-direct mapping expected
- ⚠️ requires design/refactor
- ❓ needs Codex runtime validation before implementation

## Runtime invocation

- Anthropic today: `query({ prompt, options })` stream in `container/agent-runner/src/runtime/anthropic-runtime.ts`.
- Target Codex: thread/run model in Codex SDK (resume by thread ID).
- Status: ⚠️

Notes:
- Phase 1 introduced `AgentRuntime` abstraction so the main query loop no longer depends on Anthropic message schema.

## Session continuity

- Anthropic today: `resume` + `resumeSessionAt`, while tracking `session_id` and last assistant `uuid`.
- Target Codex: runtime-specific continuation cursor + thread identifier.
- Status: ⚠️

Notes:
- Phase 1 standardizes return shape as `RunQueryResult` (`newSessionId`, `lastAssistantUuid`, `closedDuringQuery`).

## Hooks: compaction and tool sanitization

- Anthropic today:
  - `PreCompact` archives transcript before compaction.
  - `PreToolUse(Bash)` injects `unset` for sensitive env vars.
- Target Codex:
  - replicate behavior via Codex SDK hooks/events or a runtime middleware layer.
- Status: ❓

Notes:
- Phase 1 keeps both behaviors as runtime hooks passed from `index.ts` so they are already isolated from loop logic.

## Tool and permissions configuration

- Anthropic today: `allowedTools`, `permissionMode: bypassPermissions`, `allowDangerouslySkipPermissions`.
- Target Codex: Codex sandbox + approval policy equivalents.
- Status: ⚠️

Notes:
- Phase 1 preserves existing Anthropic behavior unchanged.
- Codex phase should default to least-privilege and move elevated mode behind explicit config.

## MCP server wiring

- Anthropic today: `mcpServers.nanoclaw` with `node ipc-mcp-stdio.js`.
- Target Codex: equivalent MCP registration/injection in Codex runtime.
- Status: ✅ (conceptually) / ❓ (API details)

## Global instructions and additional directories

- Anthropic today:
  - append `/workspace/global/CLAUDE.md` to system prompt preset
  - pass `/workspace/extra/*` as additional directories
- Target Codex:
  - equivalent instruction/context injection strategy.
- Status: ⚠️

## Phase-1 deliverables completed

1. Introduced runtime abstraction (`AgentRuntime`) and provider factory.
2. Moved Anthropic-specific query implementation to `runtime/anthropic-runtime.ts`.
3. Added provider switch (`NANOCLAW_AGENT_PROVIDER`), defaulting to `anthropic`.
4. Added explicit error for `codex` provider while implementation is pending.
