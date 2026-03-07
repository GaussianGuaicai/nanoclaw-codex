import { AnthropicRuntime } from './anthropic-runtime.js';
import { CodexRuntime } from './codex-runtime.js';
import { AgentRuntime, RuntimeHooks } from './types.js';

export type AgentProvider = 'anthropic' | 'codex';

export function getAgentProvider(env: NodeJS.ProcessEnv): AgentProvider {
  const raw = (env.NANOCLAW_AGENT_PROVIDER || 'anthropic').toLowerCase();
  if (raw === 'codex') return 'codex';
  return 'anthropic';
}

export function createAgentRuntime(
  provider: AgentProvider,
  hooks: RuntimeHooks,
  shouldClose: () => boolean,
  drainIpcInput: () => string[],
  ipcPollMs: number,
): AgentRuntime {
  if (provider === 'codex') {
    return new CodexRuntime(hooks);
  }

  return new AnthropicRuntime(hooks, shouldClose, drainIpcInput, ipcPollMs);
}
