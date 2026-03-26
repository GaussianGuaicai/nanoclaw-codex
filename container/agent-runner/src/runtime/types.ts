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

export type AgentTaskSource = 'chat' | 'scheduled' | 'websocket';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  taskSource?: AgentTaskSource;
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
  maintenancePurpose?: 'summary-memory';
  suppressConversationArchive?: boolean;
  secrets?: Record<string, string>;
}

export interface TurnUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export type RuntimeHook = (...args: any[]) => any;

export interface RuntimeHooks {
  onLog: (message: string) => void;
  onResult: (
    result: string | null,
    newSessionId?: string,
    usage?: TurnUsage,
  ) => void;
}

export interface IpcInputMessage {
  type: 'message' | 'background_activity';
  text: string;
}

export interface RuntimeIpc {
  shouldClose: () => boolean;
  drainIpcInput: () => IpcInputMessage[];
  ipcPollMs: number;
}

export interface RunQueryInput {
  prompt: string;
  backgroundOnly?: boolean;
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
  nextPromptBackgroundOnly?: boolean;
  usage?: TurnUsage;
}

export interface AgentRuntime {
  runQuery(input: RunQueryInput): Promise<RunQueryResult>;
}
