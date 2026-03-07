# Container Runtime → Local Codex Sandbox Mapping

This document records the current runtime shape after removing the old container and Anthropic paths.

## Runtime invocation

- Old model: host spawned a container and the container selected Anthropic or Codex at runtime.
- Current model: host spawns a local worker process that always runs Codex via `@openai/codex-sdk`.

Status: ✅ implemented

## Session continuity

- Session ID remains the Codex thread ID.
- Per-group Codex state lives under `data/sessions/{group}/.codex` and is used as `CODEX_HOME`.
- The runtime still ignores Anthropic-style `resumeAt` cursors because Codex resumes by thread ID only.

Status: ✅ implemented

## Sandbox and filesystem layout

- Old model: explicit bind mounts into `/workspace/...` inside a container.
- Current model:
  - group folder becomes the working directory
  - main group gets the repo root as an extra writable root
  - read-only extra mounts are copied into a per-group snapshot directory
  - read-write extra mounts become extra writable roots when the host allowlist permits them

Status: ✅ implemented

## MCP server wiring

- The local worker still injects `mcp_servers.nanoclaw`.
- `ipc-mcp-stdio.ts` now talks to host IPC paths directly instead of container paths.

Status: ✅ implemented

## Secrets and auth handoff

- Runtime secrets now focus on OpenAI/Codex only:
  - `OPENAI_API_KEY`
  - `OPENAI_BASE_URL`
  - `NANOCLAW_CODEX_*`
- The worker uses a minimal process environment and a per-group `CODEX_HOME`.

Status: ✅ implemented

## Skills

- Old model: `container/skills/*` copied into a container-local home directory.
- Current model: worker config registers those skill paths directly with Codex.

Status: ✅ implemented

## Removed pieces

- `NANOCLAW_AGENT_PROVIDER`
- Anthropic runtime path
- container runtime detection and startup
- container build pipeline as a runtime requirement

## Remaining gaps

- The new sandbox model is intentionally weaker than the old container isolation model.
- Read-only extra directories are snapshots, not live mounts.
- Some older docs still describe the historical container architecture and should be treated as archival unless updated.
