# Add Parallel AI Integration

Adds Parallel AI MCP access to NanoClaw for quick web search and deeper research tasks.

## Current Runtime

NanoClaw now uses a local Codex worker. Do not edit legacy container env allowlists, rebuild `container/build.sh`, or add Claude/Anthropic secrets. Prefer the current remote MCP path:

- store `PARALLEL_API_KEY` in `.env`
- expose it to a group MCP config through `bearerTokenEnvVar`
- configure the HTTP MCP servers in that group's `containerConfig.mcpServers`
- rebuild/restart only the Node app with `npm run build`

## What This Adds

- **Quick Search** via Parallel Search MCP
- **Deep Research** via Parallel Task MCP
- Optional scheduled polling for long-running research tasks

## Prerequisites

1. Parallel AI API key from https://platform.parallel.ai
2. NanoClaw already set up and running
3. Local worker build available with `npm run build`

## Implementation

### 1. Get API Key

Ask whether the user already has a Parallel AI API key. If not, direct them to create one at https://platform.parallel.ai and paste it back.

Add it to `.env`:

```bash
PARALLEL_API_KEY=<key>
```

### 2. Configure Remote MCP Servers

Add HTTP MCP servers to the target registered group's `containerConfig.mcpServers`.

Example shape:

```json
{
  "mcpServers": {
    "parallel-search": {
      "type": "http",
      "url": "https://search-mcp.parallel.ai/mcp",
      "bearerTokenEnvVar": "PARALLEL_API_KEY"
    },
    "parallel-task": {
      "type": "http",
      "url": "https://task-mcp.parallel.ai/mcp",
      "bearerTokenEnvVar": "PARALLEL_API_KEY"
    }
  }
}
```

For existing rows, update `registered_groups.container_config` carefully through SQLite or the registration flow. Preserve existing `additionalMounts`, `agentConfig`, and other keys.

### 3. Add Usage Instructions

Add concise instructions to `groups/main/AGENTS.md` or the target group `AGENTS.md`:

```markdown
## Parallel Research

Use Parallel Search for quick factual or current-information lookup.

Before starting a long Parallel Task run, ask for confirmation because it can take minutes and may cost more. For long-running research, schedule a polling task instead of blocking the chat turn.
```

### 4. Validate

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux: systemctl --user restart nanoclaw
```

Ask the user to test from a registered chat:

```text
use Parallel Search to find recent AI news
```

## Deep Research Pattern

For long-running task runs:

1. Ask permission first.
2. Create the Parallel task run.
3. Schedule an isolated polling task with `mcp__nanoclaw__schedule_task`.
4. Have the polling task check status, send results when complete, and cancel/pause itself when done if the available task tools support it.

## Troubleshooting

- MCP server missing: inspect the newest `groups/<group>/logs/worker-*.log`.
- Auth failure: verify `PARALLEL_API_KEY` exists in `.env` and the group config uses `bearerTokenEnvVar`.
- Task polling not working: inspect `scheduled_tasks` and `task_run_logs` in `store/messages.db`.

## Uninstalling

1. Remove Parallel MCP entries from the affected groups' `containerConfig.mcpServers`.
2. Remove `PARALLEL_API_KEY` from `.env` if no other integration uses it.
3. Remove the Parallel instructions from group `AGENTS.md` files.
4. Rebuild and restart.
