import { AnthropicRuntime } from './anthropic-runtime.js';
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
    throw new Error('Codex runtime is not implemented yet. Set NANOCLAW_AGENT_PROVIDER=anthropic.');
  }

  return new AnthropicRuntime(hooks, shouldClose, drainIpcInput, ipcPollMs);
}
