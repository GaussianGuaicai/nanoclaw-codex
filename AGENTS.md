# NanoClaw

Personal AI assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels are skills that self-register at startup. Messages route to a local Codex worker process. Each group has isolated `CODEX_HOME`, IPC, host-prepared workspace state, and optional structured session memory backed by SQLite plus host config in `~/.config/nanoclaw/context-config.json`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Prepares sandbox layout and spawns the local Codex worker |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/context-runtime.ts` | Records turns, updates summaries, and runs compaction |
| `src/context-bootstrap.ts` | Builds the `CONTEXT_BUNDLE` for fresh sessions |
| `src/summary-memory.ts` | Defines the structured YAML summary workflow |
| `docs/CONTEXT_MEMORY.md` | Operator guide for context memory and compaction |
| `groups/{name}/AGENTS.md` | Per-group memory (isolated) |
| `container/skills/agent-browser/SKILL.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Worker runtime issues, logs, troubleshooting |
| `/context-memory` | Enable, verify, and troubleshoot structured session memory and compaction |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile host + local worker TypeScript
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

**Channel backend failures on macOS:** if a channel backend needs access to a local messaging database, grant Full Disk Access to the process that launches NanoClaw, then restart the service.

**Context memory not updating:** Check `~/.config/nanoclaw/context-config.json`, then inspect `store/messages.db` tables `context_turns` and `group_memory_state`. Use `/context-memory` and [docs/CONTEXT_MEMORY.md](docs/CONTEXT_MEMORY.md) for the expected flow.
