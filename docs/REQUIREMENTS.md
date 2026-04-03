# NanoClaw Requirements

Original requirements and design decisions from the project creator.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

NanoClaw gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run through a local Codex worker with explicit sandbox roots and snapshots. Agents can only see what the host prepares for that group. Bash access is safe because commands run inside the worker sandbox, not in an unrestricted shared host shell.

### Built for One User

This isn't a framework or a platform. It's working software for my specific needs. I use WhatsApp and Email, so it supports WhatsApp and Email. I don't use Telegram, so it doesn't support Telegram. I add the integrations I actually want, not every possible integration.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else - just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard - Codex guides the setup. I don't need a monitoring dashboard - I ask Codex what's happening. I don't need elaborate logging UIs - I ask the agent to read the logs. I don't need debugging tools - I describe the problem and the agent fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Codex is always there.

### Skills Over Features

When people contribute, they shouldn't add "Telegram support alongside WhatsApp." They should contribute a skill like `$add-telegram` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need - not a bloated system trying to support everyone's use case simultaneously.

---

## RFS (Request for Skills)

Skills we'd love contributors to build:

### Communication Channels
Skills to add or switch to different messaging platforms:
- `$add-telegram` - Add Telegram as an input channel
- `$add-slack` - Add Slack as an input channel
- `$add-discord` - Add Discord as an input channel
- `$add-sms` - Add SMS via Twilio or similar
- `$convert-to-telegram` - Replace WhatsApp with Telegram entirely

### Runtime
The current project uses a local Codex worker by default, not Docker. For users who want different sandbox/runtime tradeoffs, repo skills can still evolve the execution model:
- `$convert-to-apple-container` - Historical/macOS migration path when container runtime experiments are needed

### Platform Support
- `$setup-linux` - Make the full setup work on Linux
- `$setup-windows` - Windows support via WSL2

---

## Vision

A personal Codex-powered assistant accessible through messaging channels, with minimal custom code.

**Core components:**
- **Codex SDK** as the core agent runtime
- **Local sandboxed worker execution** for isolated agent runs
- **WhatsApp, Slack, Telegram, Discord, Gmail** as installable channels
- **Persistent memory** per conversation and globally
- **Scheduled tasks** that run the agent and can message back
- **Web access** for search and browsing
- **Host-side WebSocket event sources** for immediate task execution

**Implementation approach:**
- Use existing tools (channels, Codex SDK, MCP servers)
- Minimal glue code
- File-based systems where possible (AGENTS.md for memory, folders for groups)

---

## Architecture Decisions

### Message Routing
- A router listens to WhatsApp and routes messages based on configuration
- Only messages from registered groups are processed
- Trigger: `@Andy` prefix (case insensitive), configurable via `ASSISTANT_NAME` env var
- Unregistered groups are ignored completely

### Memory System
- **Per-group memory**: Each group has a folder with its own `AGENTS.md`
- **Shared instruction layers**: Groups can also inherit `preferences.md`, `CLAUDE.md`, repo-root `AGENTS.md` for the main group, and `groups/global/AGENTS.md`
- **Files**: Groups can create/read files in their folder and reference them
- Agent runs in the group's folder and reads the relevant shared instruction files separately from the structured summary

### Session Management
- Groups maintain Codex sessions in SQLite (`sessions`), scoped by chat and by group event source when relevant
- Structured session memory stores a YAML summary plus turn history in SQLite (`context_turns`, `group_memory_state`)
- `~/.config/nanoclaw/context-config.json` controls summary updates, fresh-session `CONTEXT_BUNDLE`, resumed-session `MEMORY_REFRESH`, and compaction
- Fresh sessions inject a budgeted subset of relevant recent turns instead of replaying the full active tail
- Sessions can be cleared after compaction so the next turn cold-starts with the latest structured memory

### Sandbox Isolation
- Agents run through a local Codex worker with `workspace-write` sandboxing rather than a long-lived shared host shell
- Each invocation gets a group-scoped working directory plus host-selected writable roots or read-only snapshots
- The main group can see a read-only snapshot of the project root; non-main groups do not get project-root access by default
- Bash access is constrained by the worker sandbox and the mounted paths selected by the host
- Browser automation is available through the worker toolchain instead of a separate container browser image

### Scheduled Tasks
- Users can ask the agent to schedule recurring or one-time tasks from any group
- Tasks run as full agents in the context of the group that created them
- Tasks have access to all tools including Bash, constrained by the worker sandbox
- Tasks can optionally send messages to their group via `send_message` tool, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- From main: can schedule tasks for any group, view/manage all tasks
- From other groups: can only manage that group's tasks

### Group Management
- New groups are added explicitly via the main channel
- Groups are registered in SQLite (via the main channel or IPC `register_group` command)
- Each group gets a dedicated folder under `groups/`
- Groups can have additional directories mounted via `containerConfig`

### Main Channel Privileges
- Main channel is the admin/control group (typically self-chat)
- Can write to global memory (`groups/AGENTS.md`)
- Can schedule tasks for any group
- Can view and manage tasks from all groups
- Can configure additional directory mounts for any group

---

## Integration Points

### WhatsApp
- Using baileys library for WhatsApp Web connection
- Messages stored in SQLite, polled by router
- QR code authentication during setup

### Scheduler
- Built-in scheduler runs on the host and spawns isolated worker runs for task execution
- The host-side `nanoclaw` MCP server provides scheduling tools to the worker
- Tools: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute
- Tasks execute through the local Codex worker in a group-scoped sandbox context

### Web Access
- Built-in WebSearch and WebFetch tools
- Standard Codex tool capabilities plus repo-provided skills

### Browser Automation
- agent-browser CLI with Chromium available through the worker toolchain
- Snapshot-based interaction with element references (@e1, @e2, etc.)
- Screenshots, PDFs, video recording
- Authentication state persistence

---

## Setup & Customization

### Philosophy
- Minimal configuration files
- Setup and customization done through Codex skills and direct repo edits
- Users clone the repo, open Codex in the workspace, and configure the install in place
- Each user gets a custom setup matching their exact needs

### Skills
- `$setup` - Install dependencies, authenticate channels, configure scheduler, start services
- `$customize` - General-purpose skill for adding capabilities such as new channels, integrations, or behavior changes
- `$update-nanoclaw` - Pull upstream changes, merge with customizations, and run migrations safely
- `$context-memory` - Configure structured session memory, validate summary updates, and troubleshoot compaction

### Deployment
- Runs on local Mac via launchd
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Andy` (case insensitive)
- **Response prefix**: `Andy:`
- **Persona**: Default Codex (no custom personality)
- **Main channel**: Self-chat (messaging yourself in WhatsApp)

---

## Project Name

**NanoClaw** - A reference to Clawdbot (now OpenClaw).
