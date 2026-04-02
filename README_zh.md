<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  一个在每个群组本地沙箱中运行 Codex 的个人 AI 助手。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>
这个 fork 保留了 NanoClaw “小核心、skill 优先”的宿主架构，但把旧的容器运行时替换成了本地 Codex 沙箱 worker。宿主进程仍然负责渠道、路由、调度、群组状态、IPC、远程 MCP，以及宿主侧 WebSocket 事件源；Codex 则以每个群组独立的 `CODEX_HOME`、群组工作区和宿主准备好的可写根目录或只读快照来运行。

## 这个 fork 的变化

- 移除了 Anthropic runtime 支持，统一切到 Codex
- 用本地 worker 进程和 `@openai/codex-sdk` 替代旧容器生命周期管理
- 保留每个群组的会话状态，在 `data/sessions/{group}/.codex`
- 保留计划任务、IPC 工具和 skill 驱动的渠道安装
- 保留 `containerConfig` 作为兼容输入，但把它映射为沙箱 writable roots 或只读 snapshots
- 新增按群组挂载远程 MCP server 的能力
- 新增宿主侧 WebSocket 事件源，Home Assistant 是当前内置 provider

## 快速开始

```bash
git clone https://github.com/GaussianGuaicai/nanoclaw-codex.git
cd nanoclaw-codex
brew install codex
# 或者：npm install -g @openai/codex
mkdir -p .agents
ln -s ../.claude/skills .agents/skills
codex
```

然后运行 `$setup`。

> **注意：** 在 Codex 里，用 `$` 前缀调用 repo skill，比如 `$setup`、`$add-whatsapp`、`$customize`。Codex 会扫描 `.agents/skills`，而这个仓库仍把 skill 存在 `.claude/skills`，所以需要上面的 `.agents/skills -> ../.claude/skills` 符号链接。

## 设计哲学

**小巧易懂：** 单一进程，少量源文件。无微服务、无消息队列、无复杂抽象层。让 Codex 引导您轻松上手。

**通过沙箱保障安全:** 智能体运行在本地 Codex worker 的沙箱中。它们只能看到宿主明确提供的工作目录、只读快照和额外 writable roots，而不是直接拿到整个宿主文件系统。

**为单一用户打造:** 这不是一个框架，是一个完全符合您个人需求的、可工作的软件。您可以 fork 本项目，然后让 Codex 根据您的精确需求进行修改和适配。

**定制即代码修改:** 没有繁杂的配置文件。想要不同的行为？直接修改代码。代码库足够小，这样做是安全的。

**AI 原生:** 无安装向导（由 Codex 引导安装）。无需监控仪表盘，直接问智能体即可了解系统状况。描述问题，Codex 就能直接改代码或查日志。

**技能（Skills）优于功能（Features）:** 贡献者不应该把所有能力都直接塞进核心代码。更好的方式是贡献像 `$add-telegram` 这样的 repo skill，让用户按需把能力打到自己的 fork 上。

**直接运行 Codex:** 这个项目现在以 Codex 为执行核心，宿主负责调度和隔离，worker 负责实际推理、工具调用和会话延续。

## 功能支持

- **多渠道消息** - 通过 WhatsApp、Telegram、Discord、Slack 或 Gmail 与您的助手对话。使用 `$add-whatsapp` 或 `$add-telegram` 等技能添加渠道，可同时运行一个或多个。
- **隔离的群组上下文** - 每个群组都拥有独立的 `AGENTS.md`、独立 `CODEX_HOME`，以及按宿主策略准备的工作目录和文件快照。
- **主频道** - 您的私有频道（self-chat），用于管理控制；其他所有群组都完全隔离
- **计划任务** - 运行周期性或一次性的 agent 任务，并可以给您回发消息
- **网络访问** - 搜索和抓取网页内容
- **本地 Codex 沙箱** - 智能体通过本地 worker 在 `workspace-write` 沙箱中运行，可见范围由宿主准备
- **结构化会话记忆** - 可选的 `~/.config/nanoclaw/context-config.json` 能记录 turns、维护 YAML 摘要、注入 `CONTEXT_BUNDLE` / `MEMORY_REFRESH`，并在上下文过长时压缩
- **智能体集群（Agent Swarms）** - 启动多个专业智能体团队，协作完成复杂任务（首个支持此功能的个人 AI 助手）
- **可选集成** - 通过技能添加 Gmail (`$add-gmail`) 等更多功能

## 使用方法

使用触发词（默认为 `@Andy`）与您的助手对话：

```
@Andy 每周一到周五早上9点，给我发一份销售渠道的概览（需要访问我的 Obsidian vault 文件夹）
@Andy 每周五回顾过去一周的 git 历史，如果与 README 有出入，就更新它
@Andy 每周一早上8点，从 Hacker News 和 TechCrunch 收集关于 AI 发展的资讯，然后发给我一份简报
```

在主频道（您的self-chat）中，可以管理群组和任务：
```
@Andy 列出所有群组的计划任务
@Andy 暂停周一简报任务
@Andy 加入"家庭聊天"群组
```

## 定制

没有需要学习的一堆配置文件。直接告诉 Codex 您想要什么：

- "把触发词改成 @Bob"
- "记住以后回答要更简短直接"
- "当我说早上好的时候，加一个自定义的问候"
- "每周存储一次对话摘要"

结构化会话记忆使用单独的主机配置文件 `~/.config/nanoclaw/context-config.json`。它默认关闭；启用后会记录每个群组的 turns、维护 YAML 摘要，并在新会话注入 `CONTEXT_BUNDLE`、在续用会话注入更轻的 `MEMORY_REFRESH`，并在上下文变长时做压缩。详见 [docs/CONTEXT_MEMORY.md](docs/CONTEXT_MEMORY.md) 和 `$context-memory` 技能。

或者运行 `$customize` 进行引导式修改。

代码库足够小，Codex 可以安全地修改它。

## 贡献

**不要添加功能，而是添加技能。**

如果您想添加 Telegram 支持，不要创建一个 PR 同时添加 Telegram 和 WhatsApp。而是贡献一个技能文件 (`.claude/skills/add-telegram/SKILL.md`)，教 Codex 如何把一个 NanoClaw 安装改造成支持 Telegram。

然后用户在自己的 fork 上运行 `$add-telegram`，就能得到只做他们需要事情的整洁代码，而不是一个试图支持所有用例的臃肿系统。

### RFS (技能征集)

我们希望看到的技能：

**通信渠道**
- `$add-signal` - 添加 Signal 作为渠道

**会话管理**
- `$clear` - 添加一个 `$clear` 命令，用于压缩会话（在同一会话中总结上下文，同时保留关键信息）。

## 系统要求

- macOS 或 Linux
- Node.js 20+
- [Codex CLI](https://developers.openai.com/codex/quickstart/)
- ChatGPT Plan 或 `OPENAI_API_KEY`

## 架构

```
渠道 --> SQLite --> 轮询循环 -----------\
                                          --> 本地 worker runner --> Codex SDK --> 回复 / 日志
WebSocket 事件源 --> Event manager --> 即时任务执行 --/
```

单一 Node.js 进程。渠道通过 skill 添加，启动时自注册。编排器连接已有凭据的渠道，监听宿主侧 WebSocket 订阅，准备每个群组的沙箱输入，然后拉起本地 Codex worker。每个群组有独立 `CODEX_HOME`、消息队列和 IPC 命名空间。

完整架构详情请见 [docs/SPEC.md](docs/SPEC.md)。

关键文件：
- `src/index.ts` - 编排器：状态管理、消息循环、智能体调用
- `src/channels/registry.ts` - 渠道注册表（启动时自注册）
- `src/ipc.ts` - IPC 监听与任务处理
- `src/router.ts` - 消息格式化与出站路由
- `src/group-queue.ts` - 带全局并发限制的群组队列
- `src/container-runner.ts` - 准备 worker 沙箱布局并拉起本地 Codex worker
- `src/task-scheduler.ts` - 运行计划任务
- `src/db.ts` - SQLite 操作（消息、群组、会话、状态）
- `groups/*/AGENTS.md` - 各群组的记忆

## FAQ

**为什么没有 Docker/Apple Container 依赖？**

这个 fork 已经不再依赖 Docker 或 Apple Container。默认执行模型是宿主侧本地 Codex worker 加文件系统沙箱，这样部署更简单，也更贴近 Codex 本身的运行方式。

**我可以在 Linux 上运行吗？**

可以。只要有 Node.js 20+ 和 Codex CLI，就能在 macOS 或 Linux 上运行。直接运行 `$setup`。

**这个项目安全吗？**

智能体运行在本地 worker 的沙箱里，而不是直接运行在宿主机的共享 shell 中。它们只能访问宿主明确提供的工作目录、只读快照和额外 writable roots。您仍然应该审查您运行的代码，但这个代码库小到您真的可以做到。完整安全模型请见 [docs/SECURITY.md](docs/SECURITY.md)。

**为什么没有配置文件？**

我们不希望配置泛滥。每个用户都应该定制它，让代码完全符合自己的需求，而不是去配置一个通用系统。如果您喜欢用配置文件，也可以让 Codex 帮您加上。

**我可以使用第三方或开源模型吗？**

可以。NanoClaw 支持任何 API 兼容的模型端点。在 `.env` 文件中设置以下环境变量：

```bash
OPENAI_BASE_URL=https://your-api-endpoint.com
OPENAI_API_KEY=your-token-here
```

这使您能够使用：
- 通过 [Ollama](https://ollama.ai) 配合 API 代理运行的本地模型
- 托管在 [Together AI](https://together.ai)、[Fireworks](https://fireworks.ai) 等平台上的开源模型
- 兼容 OpenAI API 格式的自定义模型部署

注意：为获得最佳兼容性，模型端点需要兼容 OpenAI API。

**我该如何调试问题？**

直接问 Codex："为什么计划任务没有运行？" "最近的日志里有什么？" "为什么这条消息没有得到回应？" 这就是 AI 原生的工作方式。

**为什么我的安装不成功？**

如果遇到问题，安装过程中 Codex 会尝试动态修复。如果问题仍然存在，运行 `codex`，然后执行 `$debug`。如果 Codex 发现了可能影响其他用户的问题，欢迎提 PR 修改 setup skill。

**什么样的代码更改会被接受？**

安全修复、bug 修复，以及对基础配置的明确改进。仅此而已。

其他一切（新功能、操作系统兼容性、硬件支持、增强功能）都应该作为技能来贡献。

这使得基础系统保持最小化，并让每个用户可以定制他们的安装，而无需继承他们不想要的功能。

## 社区

有任何疑问或建议？欢迎[加入 Discord 社区](https://discord.gg/VDdww8qS42)与我们交流。

## 更新日志

破坏性变更和迁移说明请见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT
