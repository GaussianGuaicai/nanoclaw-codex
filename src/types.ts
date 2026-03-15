export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Compatibility alias for the snapshot/writable-root name under /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

export interface RemoteMcpServerConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
  bypassProxy?: boolean;
  bridgeToStdio?: boolean;
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is never exposed to workers, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can become worker writable roots or snapshot sources
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  mcpServers?: Record<string, RemoteMcpServerConfig>;
  agentConfig?: AgentExecutionSourceConfig;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  agent_config?: AgentExecutionConfig;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

export type EventExecutionContextMode = 'group' | 'isolated';
export type AgentTaskSource = 'chat' | 'scheduled' | 'websocket';
export type WebSocketProviderName = string;
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

export interface AgentExecutionSourceConfig {
  defaults?: AgentExecutionConfig;
  bySource?: Partial<Record<AgentTaskSource, AgentExecutionConfig>>;
}

export type AgentExecutionConfigScope =
  | 'global'
  | 'group'
  | 'websocket'
  | 'task';

export type WebSocketMatchValue = string | number | boolean | null;
export type WebSocketFilterOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not_in'
  | 'starts_with'
  | 'not_starts_with'
  | 'exists'
  | 'not_exists';

export interface WebSocketFilterRule {
  path: string;
  op: WebSocketFilterOperator;
  value?: WebSocketMatchValue | WebSocketMatchValue[];
  valueFromPath?: string;
}

export interface WebSocketConnectionConfig {
  provider: WebSocketProviderName;
  urlEnvVar: string;
  tokenEnvVar: string;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  features?: {
    coalesceMessages?: boolean;
  };
}

export interface WebSocketSubscriptionConfig {
  id: string;
  connection: string;
  kind: 'events';
  eventType: string;
  filters?: WebSocketFilterRule[];
  match?: Record<string, WebSocketMatchValue | WebSocketMatchValue[]>;
  logFilteredEvents?: boolean;
  logCooldownEvents?: boolean;
  runTask?: boolean;
  logTaskResult?: boolean;
  taskInstructions?: string;
  taskInstructionsPath?: string;
  targetJid: string;
  promptTemplate: string;
  contextMode?: EventExecutionContextMode;
  deliverOutput?: boolean;
  cooldownMs?: number;
  agentConfig?: AgentExecutionConfig;
}

export interface WebSocketSourcesConfig {
  connections: Record<string, WebSocketConnectionConfig>;
  subscriptions: WebSocketSubscriptionConfig[];
}

export interface NormalizedWebSocketEvent {
  connectionName: string;
  subscriptionId: string;
  provider: WebSocketProviderName;
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}
