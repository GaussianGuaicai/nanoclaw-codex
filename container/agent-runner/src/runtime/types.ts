export type AgentModelReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface AgentExecutionConfig {
  model?: string;
  reasoningEffort?: AgentModelReasoningEffort;
  codexConfigOverrides?: Record<string, unknown>;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentConfig?: AgentExecutionConfig;
  remoteMcpServers?: Record<
    string,
    {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    }
  >;
  remoteMcpNoProxyHosts?: string[];
  remoteMcpBridgeNames?: string[];
  runtimePaths?: {
    groupPath: string;
    ipcPath: string;
    codexHome: string;
    additionalDirectories: string[];
    writableRoots: string[];
    sharedInstructionFiles: string[];
  };
  secrets?: Record<string, string>;
}

export type RuntimeHook = (...args: any[]) => any;

export interface RuntimeHooks {
  onLog: (message: string) => void;
  onResult: (result: string | null, newSessionId?: string) => void;
}

export interface RuntimeIpc {
  shouldClose: () => boolean;
  drainIpcInput: () => string[];
  ipcPollMs: number;
}

export interface RunQueryInput {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  mcpServerCommand: string;
  mcpServerArgs: string[];
  containerInput: ContainerInput;
  sdkEnv: Record<string, string | undefined>;
}

export interface RunQueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  nextPrompt?: string;
}

export interface AgentRuntime {
  runQuery(input: RunQueryInput): Promise<RunQueryResult>;
}
