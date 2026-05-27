export interface KoraConfig {
  settings: Settings;
  providers: ProviderConfig[];
  channels: ChannelConfig[];
}

export interface ToolSettings {
  scheduler?: boolean;
  mail?: boolean;
  mail_delegation?: boolean;
  identity?: boolean;
  browser?: boolean;
  web_search?: boolean;
  homeassistant_mqtt?: boolean;
  shell?: boolean;
  mcp?: boolean;
  settings?: boolean;
  web_fetch?: boolean;
  stt?: boolean;
  tts?: boolean;
  stt_model?: 'tiny' | 'base' | 'small';
  tts_voice?: string;
  web_search_api_key?: string;
  web_search_engine?: 'brave' | 'google';
  ha_url?: string;
  ha_token?: string;
}

export interface HeartbeatSettings {
  enabled: boolean;
  intervalMinutes: number;
  concurrency?: number;
}

export interface WebAdminSettings {
  enabled: boolean;
  port: number;
  token?: string;
  username?: string;
  password?: string;
}

export interface SandboxMount {
  hostPath: string;
  containerPath: string;
  mode: 'ro' | 'rw';
}

export interface ShellSandboxSettings {
  allowedPaths: string[];
  customEnv?: Record<string, string>;
  containerEnabled?: boolean;
  backend?: 'auto' | 'docker' | 'macos_seatbelt' | 'firejail';
  dockerImage?: string;
  mounts?: SandboxMount[];
  networkAccess?: boolean;
  memoryLimitMb?: number;
  /** Keep Docker sandbox containers alive between commands (seconds, 0 = disabled). */
  dockerKeepAlive?: number;
}

export interface EmbeddingSettings {
  provider: 'auto' | 'openai' | 'openai_compat' | 'local';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface Settings {
  storagePath: string;
  defaultProvider: string;
  defaultModel: string;
  maxTokens: number;
  maxContextTokens: number;
  maxIterations: number;
  maxIterationsEnforced: number;
  multiUser: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  tools: ToolSettings;
  heartbeat: HeartbeatSettings;
  web_admin: WebAdminSettings;
  shell_sandbox?: ShellSandboxSettings;
  embedding?: EmbeddingSettings;
  mail_delegation?: {
    google_client_id?: string;
    google_client_secret?: string;
  };
  billing?: BillingSettings;
}

export interface ProviderConfig {
  id: string;
  type: 'openai' | 'anthropic' | 'openai_compat';
  apiKey?: string;
  baseUrl?: string;
  models: ModelConfig[];
}

export type ModelRole = 'default' | 'fallback' | 'fast' | 'capable' | 'vision' | 'coding' | 'multimodal' | 'long-context' | 'cheap' | 'planner' | 'creative' | 'translator' | 'summarizer';

export interface ModelConfig {
  id: string;
  name: string;
  maxTokens?: number;
  toolCallProfile?: 'standard' | 'qwen' | 'custom';
  reasoningEffort?: 'low' | 'medium' | 'high';
  roles?: ModelRole[];
}

export interface ChannelConfig {
  id: string;
  type: 'telegram' | 'email' | 'gmail' | 'mqtt';
  enabled: boolean;
  config: TelegramChannelConfig | EmailChannelConfig | GmailChannelConfig | MqttChannelConfig;
}

export interface TelegramChannelConfig {
  token: string;
  allowedChatIds?: number[];
}

export interface EmailChannelConfig {
  imap: {
    host: string;
    port: number;
    user: string;
    password: string;
    tls: boolean;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    password: string;
    secure: boolean;
  };
  allowedSenders?: string[];
}

export interface GmailChannelConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  email?: string;
  pollIntervalSeconds?: number;
  allowedSenders?: string[];
}

export interface MqttChannelConfig {
  broker_url: string;
  username?: string;
  password?: string;
  subscribe_topics: string[];
  response_topic?: string;
  client_id?: string;
}

export interface Identity {
  id: string;
  channel: string;
  channelUserId: string;
  workspaceId: string | null;
  userId: string | null;
  linkedAt: Date | null;
  pairingCode: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  ownerUserId: string | null;
  createdAt: Date;
  isDefault: boolean;
}

export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'suspended' | 'pending' | 'pending_verification';
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'none';

export interface User {
  id: string;
  email: string | null;
  passwordHash: string;
  displayName: string | null;
  role: UserRole;
  status: UserStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus;
  subscriptionStartDate: Date | null;
  planId: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface RegistrationCode {
  code: string;
  telegramChatId: string;
  telegramUsername: string | null;
  email: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedByUserId: string | null;
}

export interface UsageLog {
  id: number;
  userId: string;
  workspaceId: string;
  providerId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: Date;
}

export interface BillingModelConfig {
  provider: string;
  included_calls: number;
}

export interface BillingSettings {
  enabled: boolean;
  dailyLimit?: number;
  stripe?: {
    secretKey: string;
    webhookSecret: string;
    priceId: string;
    portalConfigId?: string;
    testMode?: boolean;
  };
  models: Record<string, BillingModelConfig>;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  channelId: string;
  identityId: string;
  workspaceId: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

export interface ReasoningOptions {
  effort: 'none' | 'low' | 'medium' | 'high';
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  model?: string;
  provider?: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: ReasoningOptions;
  workspaceId?: string;
}

export interface MultimodalPart {
  type: 'text' | 'image';
  text?: string;
  imageBase64?: string;
  mimeType?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  timestamp?: Date;
  multimodal?: MultimodalPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  injected?: boolean;
}

export interface ChatResponse {
  content: string | null;
  reasoning?: string | null;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SkillRequirements {
  bins?: string[];
  env?: string[];
}

export interface SkillManifest {
  name: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  compatibility?: string;
  homepage?: string;
  emoji?: string;
  metadata?: Record<string, unknown>;
  requires?: SkillRequirements;
  dirPath?: string;
  instructions?: string;
}

export interface ScheduledTask {
  id: string;
  workspaceId: string;
  name: string;
  cronExpression: string;
  agentId: string;
  skillName?: string;
  prompt?: string;
  enabled: boolean;
  lastRun: Date | null;
  nextRun: Date | null;
  createdAt: Date;
}

export interface EventAttachment {
  type: 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'sticker';
  fileId: string;
  fileName?: string;
  mimeType?: string;
  localPath?: string;
  caption?: string;
}

export interface IncomingEvent {
  channel: string;
  identityId: string;
  type: 'message' | 'command' | 'callback' | 'email';
  content: string;
  attachments?: EventAttachment[];
  metadata?: Record<string, unknown>;
  raw?: unknown;
  drainPendingMessages?: () => string[];
  sendInterimMessage?: (text: string) => Promise<void>;
  sendFile?: (filePath: string, options?: { caption?: string; type?: 'photo' | 'document' }) => Promise<void>;
  waitForReply?: (timeoutMs: number) => Promise<IncomingEvent | null>;
  setTyping?: (active: boolean) => void;
  sendToolStatus?: (toolName: string, phase: 'start' | 'end') => void;
}

export interface OutgoingEvent {
  channel: string;
  identityId: string;
  type: 'message' | 'action' | 'buttons';
  content: string;
  buttons?: InlineButton[][];
  metadata?: Record<string, unknown>;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export type EventHandler = (event: IncomingEvent) => Promise<void>;
