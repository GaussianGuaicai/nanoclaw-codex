# NanoClaw Specification

NanoClaw is a personal Codex-powered assistant with installable messaging channels, per-group state, scheduled tasks, host-side event sources, and a local sandboxed Codex worker.

This document describes the current runtime. Older design notes about Docker, Apple Container, Claude Code, or the Anthropic SDK are historical unless they explicitly say otherwise.

## Current Shape

```text
Connected channels -> SQLite -> message loop -----\
                                                    -> GroupQueue -> local Codex worker -> channel reply / logs
Scheduled tasks ----------------------------------/
WebSocket event sources -> immediate task runner --/

Worker side effects -> nanoclaw MCP over file IPC -> host authorization -> channel / scheduler / group changes
```

The host process is a single Node.js service. It owns channel connections, SQLite state, scheduling, WebSocket event-source lifecycles, sandbox layout preparation, and IPC authorization. For each agent run it spawns `container/agent-runner`, which is now a local worker process rather than a container image.

## Core Components

| Component | Current implementation |
|-----------|------------------------|
| Host service | `src/index.ts` |
| Channel registry | `src/channels/registry.ts`, loaded by `src/channels/index.ts` |
| Message and task store | SQLite at `store/messages.db` |
| Queueing | `src/group-queue.ts`, with a global concurrency cap |
| Worker launcher | `src/container-runner.ts` |
| Worker runtime | `container/agent-runner/src/runtime/codex-runtime.ts` using `@openai/codex-sdk` |
| Worker MCP bridge | `container/agent-runner/src/ipc-mcp-stdio.ts` |
| Structured context memory | `src/context-runtime.ts`, `src/context-bootstrap.ts`, `src/summary-memory.ts` |
| WebSocket event sources | `src/event-sources/*` |

The `container/` directory name is retained for compatibility with earlier file paths. The runtime is local Codex worker execution, not Docker or Apple Container.

## Channel System

Channels are ordinary TypeScript modules that self-register at import time.

1. A channel skill adds `src/channels/<name>.ts`.
2. The channel calls `registerChannel('<name>', factory)`.
3. The skill adds `import './<name>.js';` to `src/channels/index.ts`.
4. At startup, the host instantiates registered channel factories whose credentials are present.

Every channel implements `Channel` from `src/types.ts`:

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

The base architecture supports WhatsApp, Telegram, Slack, Discord, and Gmail as skills. This checkout currently has the Slack skill applied.

## Runtime Paths

| Path | Purpose |
|------|---------|
| `groups/{folder}/` | Group working directory, writable by that group's worker |
| `groups/global/` | Shared instruction directory, exposed as a read-only snapshot |
| `data/sessions/{folder}/.codex` | Per-group `CODEX_HOME` |
| `data/sessions/{folder}/sandbox-context/` | Per-run copied snapshots such as project/global/extra dirs |
| `data/ipc/{folder}/` | Per-group IPC namespace and snapshots |
| `groups/{folder}/logs/worker-*.log` | Per-run worker logs |
| `logs/nanoclaw.log` | Host log |
| `store/messages.db` | SQLite state |

Group folder names must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`; `global` is reserved.

## Sandbox Layout

Each run receives:

- `workingDirectory`: the group folder
- `CODEX_HOME`: `data/sessions/{group}/.codex`
- `additionalDirectories`: host-prepared read-only snapshots and approved extra directories
- `writable_roots`: only paths explicitly allowed by the host

Main groups receive a read-only sanitized snapshot of the project root under the per-run sandbox context; `.env` is removed from that snapshot. Non-main groups do not get project-root access by default.

`containerConfig.additionalMounts` remains a compatibility input:

- `readonly !== false`: copied into `sandbox-context` as a snapshot
- `readonly === false`: exposed as an extra writable root only if allowed by `~/.config/nanoclaw/mount-allowlist.json`

## Codex Configuration

SDK/runtime secrets are read from `.env` and passed to the local worker as structured input, not exported wholesale into the worker process environment.

Common keys:

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://your-compatible-endpoint.example
NANOCLAW_CODEX_MODEL=gpt-5.4-mini
NANOCLAW_CODEX_SANDBOX_MODE=workspace-write
NANOCLAW_CODEX_APPROVAL_POLICY=never
NANOCLAW_CODEX_NETWORK_ACCESS=true
NANOCLAW_CODEX_WEB_SEARCH_ENABLED=false
NANOCLAW_CODEX_WEB_SEARCH_MODE=disabled
NANOCLAW_CODEX_REASONING_EFFORT=medium
```

Model overrides can also be provided in `~/.config/nanoclaw/agent-config.json`.

Precedence:

```text
task override > source override > group config > global config > legacy env > SDK default
```

Group-only worker environment values live in `~/.config/nanoclaw/group-secrets.json`. Only keys declared for that group are exported to that group's worker process.

## Shared Instructions And Memory

Workers receive shared instructions through Codex `developer_instructions`, built from existing instruction files:

- `AGENTS.md`, `CLAUDE.md`, or `preferences.md` in the group folder
- repo-root instruction files for the main group
- `groups/global/AGENTS.md`, `groups/global/CLAUDE.md`, or `groups/global/preferences.md`
- instruction files found in approved extra writable roots or snapshots

Structured session memory is separate from instruction files. When enabled by `~/.config/nanoclaw/context-config.json`, it stores turns and summaries in SQLite, injects `CONTEXT_BUNDLE` for fresh sessions, injects `MEMORY_REFRESH` for resumed sessions, and can clear live sessions after sliding-window compaction.

See `docs/CONTEXT_MEMORY.md`.

## Message Flow

1. A connected channel receives a message.
2. The channel stores chat metadata and message content in SQLite.
3. The message loop polls for new messages.
4. The router ignores unregistered chats.
5. Non-main groups require the trigger pattern unless `requiresTrigger` is false.
6. The host formats missed messages since the last successful agent response.
7. The group queue starts or reuses a local worker for that chat.
8. The worker runs Codex with the prepared sandbox layout and `nanoclaw` MCP server.
9. User-visible output is sent through the channel that owns the JID.
10. Cursor/session/context-memory state is updated after success.

Outbound formatting strips `<internal>...</internal>` blocks and otherwise sends the model's text unchanged.

## IPC And MCP Tools

The worker exposes a local `nanoclaw` MCP server. Tools write JSON files under `data/ipc/{group}/`, and the host applies side effects after authorization.

| Tool | Host-side effect |
|------|------------------|
| `send_message` | Send to the current chat, or any chat if called by main |
| `schedule_task` | Create a cron, interval, or one-time task |
| `list_tasks` | Read task snapshot; main sees all, groups see their own |
| `pause_task` / `resume_task` / `cancel_task` / `update_task` | Manage authorized tasks |
| `register_group` | Main-only registration of a new chat/group |

Non-main groups cannot send messages to other chats, schedule tasks for other groups, or register groups.

## Scheduled Tasks

Scheduled tasks are stored in `scheduled_tasks` and run through the same local worker path as chat turns.

Supported schedule types:

| Type | Value |
|------|-------|
| `cron` | Standard cron expression interpreted in `TIMEZONE` |
| `interval` | Milliseconds between runs |
| `once` | ISO-like timestamp |

Tasks have `context_mode`:

- `group`: participates in the group's live/session-memory context
- `isolated`: fresh session with no group conversation history unless the prompt includes it

Tasks can deliver output back to the channel, complete silently with `<internal>...</internal>`, and carry per-task model config.

## WebSocket Event Sources

Host-side WebSocket sources are configured in:

```text
~/.config/nanoclaw/websocket-sources.json
```

Current built-in provider: Home Assistant.

Matching events can:

- log to provider-specific JSONL files such as `logs/websocket-events-home_assistant.log`
- run an immediate agent task
- use `contextMode: "group"` or `"isolated"`
- send output back through the owning channel when `deliverOutput` is true
- use per-subscription `agentConfig`

See `docs/WEBSOCKET_EVENT_SOURCES.md`.

## Service And Setup

Setup is skill-driven:

```bash
bash setup.sh
npx tsx setup/index.ts --step environment
npx tsx setup/index.ts --step worker
npx tsx setup/index.ts --step service
npx tsx setup/index.ts --step verify
```

`--step container` is kept as a compatibility alias for `--step worker`.

On macOS, setup writes a launchd plist under `~/Library/LaunchAgents/com.nanoclaw.plist`. On Linux, it uses user/system systemd when available and falls back to a nohup wrapper for WSL-like environments without systemd.

## Security Model

The main boundary is Codex sandbox policy plus host-prepared filesystem access. It is intentionally simpler and weaker than the old container/VM model.

Important guarantees:

- project `.env` is not copied into the main group's project snapshot
- channel auth state stays host-side under `store/`
- mount and sender allowlists stay outside the repo
- side effects go through host-authorized IPC
- per-group Codex state is isolated by `CODEX_HOME`

Important residual risks:

- Codex sandboxing is not equivalent to VM isolation
- copied snapshots can be stale between runs
- approved writable roots are directly mutable by Codex

See `docs/SECURITY.md`.
