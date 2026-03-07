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
- Codex: partial compatibility implemented in runtime middleware (env sanitization and per-turn archive).
- Status: ⚠️

Notes:
- Codex runtime sanitizes process environment before spawning Codex CLI.
- Codex runtime writes lightweight conversation archives to `groups/*/conversations/` after each turn.

## Tool and permissions configuration

- Anthropic: explicit `allowedTools` + bypass permission mode.
- Codex: uses Codex SDK defaults in current runtime implementation.
- Status: ❓

## MCP server wiring

- Anthropic: `mcpServers.nanoclaw` with `node ipc-mcp-stdio.js`.
- Codex: runtime now injects `mcp_servers.nanoclaw` via Codex SDK config.
- Status: ⚠️

Notes:
- Basic MCP bridge is implemented for Codex runtime.
- Full parity for hook-mediated policies and tool filtering is still pending.

## Secrets and auth handoff

- Container secret allowlist now includes `OPENAI_API_KEY`.
- Bash sanitization hook now unsets `OPENAI_API_KEY` in addition to Anthropic auth vars.
- Codex runtime now supports both auth modes:
  - API key (`OPENAI_API_KEY`)
  - ChatGPT login credentials from `~/.codex`
- Container runtime now mounts per-group `.codex` to `/home/node/.codex`.
- Status: ✅


## Provider configuration handoff

- Container secret pass-through now includes Codex runtime controls:
  - `NANOCLAW_AGENT_PROVIDER`
  - `NANOCLAW_CODEX_MODEL`
  - `NANOCLAW_CODEX_SANDBOX_MODE`
  - `NANOCLAW_CODEX_APPROVAL_POLICY`
  - `NANOCLAW_CODEX_NETWORK_ACCESS`
  - `NANOCLAW_CODEX_WEB_SEARCH_ENABLED`
  - `NANOCLAW_CODEX_WEB_SEARCH_MODE`
  - `NANOCLAW_CODEX_REASONING_EFFORT`
  - `OPENAI_BASE_URL`
- Status: ✅

## Completed migration phases

### Phase 1 (completed)

1. Introduced runtime abstraction (`AgentRuntime`) and provider factory.
2. Moved Anthropic-specific query implementation to `runtime/anthropic-runtime.ts`.
3. Decoupled main loop in `index.ts` from Anthropic event schema.

### Phase 2 (completed)

1. Implemented a minimal Codex runtime adapter (`runtime/codex-runtime.ts`).
2. Enabled actual provider switching to Codex in runtime factory.
3. Added OpenAI key pass-through (`OPENAI_API_KEY`) for container runtime.

### Phase 3 (completed in this change)

1. Added container-side passthrough for Codex provider controls (`NANOCLAW_CODEX_*`).
2. Added `OPENAI_BASE_URL` passthrough for non-default deployments.

## Next phase

1. Add Codex runtime parity for MCP tool wiring.
2. Add Codex-side equivalent for pre-tool sanitization and pre-compaction archiving.
3. Align permission/sandbox policy behavior across Anthropic and Codex modes.
