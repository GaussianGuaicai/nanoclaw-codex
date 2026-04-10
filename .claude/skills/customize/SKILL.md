---
name: customize
description: Add new capabilities or modify NanoClaw behavior. Use when user wants to add channels (Telegram, Slack, email input), change triggers, add integrations, modify the router, or make any other customizations. This is an interactive skill that asks questions to understand what the user wants.
---

# NanoClaw Customization

This skill helps users add capabilities or modify behavior. Ask concise clarifying questions only when the answer cannot be inferred safely from the repo or the user's request.

## Workflow

1. **Understand the request** - Ask clarifying questions
2. **Plan the changes** - Identify files to modify
3. **Implement** - Make changes directly to the code
4. **Test guidance** - Tell user how to verify

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel self-registration registry |
| `src/channels/index.ts` | Barrel imports for installed channels |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/types.ts` | TypeScript interfaces (includes Channel) |
| `src/config.ts` | Assistant name, trigger pattern, directories |
| `src/db.ts` | Database initialization and queries |
| `src/agent-config.ts` | Model/reasoning config resolution |
| `src/context-runtime.ts` | Structured context memory runtime |
| `src/event-sources/manager.ts` | Host-side WebSocket event-source manager |
| `container/agent-runner/src/runtime/codex-runtime.ts` | Local Codex worker runtime |
| `groups/global/AGENTS.md` | Shared instructions, exposed to workers as a snapshot |

## Common Customization Patterns

### Adding a New Input Channel (e.g., Telegram, Slack, Email)

Questions to ask:
- Which channel? (Telegram, Slack, Discord, email, SMS, etc.)
- Same trigger word or different?
- Same memory hierarchy or separate?
- Should messages from this channel go to existing groups or new ones?

Implementation pattern:
1. Create `src/channels/{name}.ts` implementing the `Channel` interface from `src/types.ts`
2. Register it with `registerChannel(name, factory)` at module load time
3. Add `import './{name}.js';` to `src/channels/index.ts`
4. Return `null` from the factory when credentials are missing so startup can skip the channel cleanly
5. Messages are stored through the `onMessage` callback; outbound routing is automatic via `ownsJid()`

### Adding a New MCP Integration

Questions to ask:
- What service? (Calendar, Notion, database, etc.)
- What operations needed? (read, write, both)
- Which groups should have access?

Implementation:
1. Prefer `containerConfig.mcpServers` for per-group HTTP/SSE MCP servers.
2. Use `bearerTokenEnvVar`, `bypassProxy`, or `bridgeToStdio` when needed.
3. For local stdio tools, modify `container/agent-runner/src/runtime/codex-runtime.ts` and document the tool in `groups/global/AGENTS.md` or the target group `AGENTS.md`.

### Changing Assistant Behavior

Questions to ask:
- What aspect? (name, trigger, persona, response style)
- Apply to all groups or specific ones?

Simple trigger/name changes → edit `src/config.ts` or `.env`
Model changes → edit `~/.config/nanoclaw/agent-config.json` or `containerConfig.agentConfig`
Shared behavior → edit `groups/global/AGENTS.md`
Per-group behavior → edit `groups/{folder}/AGENTS.md`

### Adding New Commands

Questions to ask:
- What should the command do?
- Available in all groups or main only?
- Does it need new MCP tools?

Implementation:
1. Commands are handled by the agent naturally — add instructions to `groups/global/AGENTS.md` or the group's `AGENTS.md`
2. For trigger-level routing changes, modify `processGroupMessages()` in `src/index.ts`

### Changing Deployment

Questions to ask:
- Target platform? (macOS launchd, Linux systemd, WSL/nohup)
- Service manager? (launchd, systemd, nohup fallback)

Implementation:
1. Create appropriate service files
2. Update paths in config
3. Provide setup instructions

## After Changes

Always tell the user:
```bash
# Rebuild and restart
npm run build
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
# systemctl --user restart nanoclaw
```

## Example Interaction

User: "Add Telegram as an input channel"

1. Ask: "Should Telegram use the same @Andy trigger, or a different one?"
2. Ask: "Should Telegram messages create separate conversation contexts, or share with WhatsApp groups?"
3. Create `src/channels/telegram.ts` implementing the `Channel` interface
4. Register the channel and add the barrel import in `src/channels/index.ts`
5. Tell user how to authenticate and test
