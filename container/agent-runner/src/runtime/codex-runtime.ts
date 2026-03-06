import { AgentRuntime, RunQueryInput, RunQueryResult, RuntimeHooks } from './types.js';

interface CodexThread {
  id?: string;
  run(prompt: string): Promise<unknown>;
}

interface CodexClient {
  startThread(): CodexThread;
  resumeThread(threadId: string): CodexThread;
}

function extractResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result == null) return '';

  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (typeof obj.outputText === 'string') return obj.outputText;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export class CodexRuntime implements AgentRuntime {
  constructor(private readonly hooks: RuntimeHooks) {}

  async runQuery(input: RunQueryInput): Promise<RunQueryResult> {
    const { prompt, sessionId, resumeAt, sdkEnv } = input;

    if (resumeAt) {
      this.hooks.onLog(`Codex runtime currently ignores resumeAt cursor: ${resumeAt}`);
    }

    const { Codex } = await import('@openai/codex-sdk');

    const client = new Codex({
      apiKey: sdkEnv.OPENAI_API_KEY,
    }) as CodexClient;

    const thread = sessionId ? client.resumeThread(sessionId) : client.startThread();
    const result = await thread.run(prompt);
    const text = extractResultText(result);
    const newSessionId = thread.id || sessionId;

    this.hooks.onResult(text || null, newSessionId);

    return {
      newSessionId,
      lastAssistantUuid: undefined,
      closedDuringQuery: false,
    };
  }
}
