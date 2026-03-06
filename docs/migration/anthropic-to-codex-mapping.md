# Anthropic Agent SDK → Codex SDK Mapping

This document records the migration surface from NanoClaw's current Anthropic runtime to Codex runtime support.

## Status legend

- ✅ implemented
- ⚠️ partial (works, but behavior differs)
- ❓ pending design/validation

## Runtime invocation

- Anthropic: `query({ prompt, options })` stream in `container/agent-runner/src/runtime/anthropic-runtime.ts`.
- Codex: thread-based runtime in `container/agent-runner/src/runtime/codex-runtime.ts`.
- Status: ⚠️

Notes:
- `NANOCLAW_AGENT_PROVIDER=anthropic|codex` now selects runtime at startup.
- Anthropic runtime streams intermediate events; Codex runtime currently runs one prompt/one result per loop iteration.

## Session continuity

- Anthropic: `resume` + `resumeSessionAt` with last assistant UUID cursor.
- Codex: uses thread resume via `resumeThread(sessionId)`.
- Status: ⚠️

Notes:
- Codex runtime ignores `resumeAt` cursor for now (logged as informational).
- `newSessionId` comes from thread id when available.

## Hooks: compaction and tool sanitization

- Anthropic: `PreCompact` and `PreToolUse(Bash)` hooks are active.
- Codex: no equivalent hooks wired yet in runtime.
- Status: ❓

## Tool and permissions configuration

- Anthropic: explicit `allowedTools` + bypass permission mode.
- Codex: uses Codex SDK defaults in current runtime implementation.
- Status: ❓

## MCP server wiring

- Anthropic: `mcpServers.nanoclaw` with `node ipc-mcp-stdio.js`.
- Codex: MCP server wiring is not yet implemented in runtime.
- Status: ❓

## Secrets and auth handoff

- Container secret allowlist now includes `OPENAI_API_KEY`.
- Bash sanitization hook now unsets `OPENAI_API_KEY` in addition to Anthropic auth vars.
- Status: ✅

## Completed migration phases

### Phase 1 (completed)

1. Introduced runtime abstraction (`AgentRuntime`) and provider factory.
2. Moved Anthropic-specific query implementation to `runtime/anthropic-runtime.ts`.
3. Decoupled main loop in `index.ts` from Anthropic event schema.

### Phase 2 (completed in this change)

1. Implemented a minimal Codex runtime adapter (`runtime/codex-runtime.ts`).
2. Enabled actual provider switching to Codex in runtime factory.
3. Added OpenAI key pass-through (`OPENAI_API_KEY`) for container runtime.

## Next phase

1. Add Codex runtime parity for MCP tool wiring.
2. Add Codex-side equivalent for pre-tool sanitization and pre-compaction archiving.
3. Align permission/sandbox policy behavior across Anthropic and Codex modes.
