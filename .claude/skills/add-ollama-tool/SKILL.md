---
name: add-ollama-tool
description: Add a local Ollama MCP server so the Codex worker can call local models for cheaper/faster summarization, translation, or general helper tasks.
---

# Add Ollama Integration

This skill adds a stdio MCP server that exposes local Ollama models to the local Codex worker.

Tools added:

- `ollama_list_models` — lists installed Ollama models
- `ollama_generate` — sends a prompt to a model and returns the response

## Current Runtime Note

NanoClaw now runs a local Codex worker, not a Docker container. Avoid Docker-only assumptions such as `host.docker.internal`, per-group `agent-runner-src` copies, or rebuilding `container/build.sh`.

The skill package may still contain old container-era `modify/` files. If an apply operation conflicts, port the intended changes into the current local-worker files:

- `container/agent-runner/src/ollama-mcp-stdio.ts`
- `container/agent-runner/src/runtime/codex-runtime.ts`
- `src/container-runner.ts` only if host log surfacing is still needed

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `ollama` is in `applied_skills`, skip to configuration and verification.

### Check prerequisites

Verify Ollama is installed and running on the host:

```bash
ollama list
```

If Ollama is not installed, direct the user to https://ollama.com/download.

If no models are installed, suggest pulling one:

```bash
ollama pull gemma3:1b
ollama pull llama3.2
ollama pull qwen3-coder:30b
```

## Phase 2: Apply Code Changes

Initialize the skills system if needed:

```bash
npx tsx scripts/apply-skill.ts --init
```

Apply the skill:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-ollama-tool
```

Expected outcome:

- add `container/agent-runner/src/ollama-mcp-stdio.ts`
- register an `ollama` stdio MCP server in the Codex runtime's `mcp_servers` config
- allow the worker to reach the host Ollama endpoint through `OLLAMA_HOST`
- record the application in `.nanoclaw/state.yaml`

Validate:

```bash
npm run build
```

## Phase 3: Configure

By default, local worker processes can use:

```bash
OLLAMA_HOST=http://127.0.0.1:11434
```

Add a different `OLLAMA_HOST` to `.env` only when Ollama is not listening on localhost.

Restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

Tell the user to ask from a registered chat:

```text
use ollama to list available local models
```

Then monitor:

```bash
tail -f logs/nanoclaw.log | grep -i ollama
ls -lt groups/*/logs/worker-*.log | head
```

## Troubleshooting

### Failed to connect to Ollama

1. Verify Ollama is running: `ollama list`
2. Check `OLLAMA_HOST` in `.env`
3. From the host, test: `curl -s http://127.0.0.1:11434/api/tags`

### Agent does not see Ollama tools

1. Check that `container/agent-runner/src/runtime/codex-runtime.ts` includes the `ollama` MCP server entry.
2. Rebuild with `npm run build`.
3. Restart the service.
4. Inspect the newest `groups/<group>/logs/worker-*.log` for MCP startup errors.
