export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export type RuntimeHook = (...args: any[]) => any;

export interface RuntimeHooks {
  onLog: (message: string) => void;
  onResult: (result: string | null, newSessionId?: string) => void;
  onPreCompact: RuntimeHook;
  onPreToolUseBash: RuntimeHook;
}

export interface RunQueryInput {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  mcpServerPath: string;
  containerInput: ContainerInput;
  sdkEnv: Record<string, string | undefined>;
}

export interface RunQueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}

export interface AgentRuntime {
  runQuery(input: RunQueryInput): Promise<RunQueryResult>;
}
