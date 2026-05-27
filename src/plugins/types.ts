import type { IncomingEvent, OutgoingEvent } from '../core/types.js';

export interface PluginManifest {
  name: string;
  version: string;
  type: 'channel' | 'connector';
  description?: string;
}

export interface ChannelCallbacks {
  onMessage: (event: IncomingEvent) => Promise<void>;
  resolveIdentity: (channel: string, userId: string) => { workspaceId?: string } | undefined;
  registerIdentity: (channel: string, userId: string, workspaceId?: string) => { workspaceId?: string };
}

export interface ChannelPlugin extends PluginManifest {
  type: 'channel';
  initialize(config: Record<string, unknown>, callbacks: ChannelCallbacks): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(identityId: string, event: OutgoingEvent): Promise<void>;
  getSetupQuestions?(): PluginSetupQuestion[];
}

export interface ConnectorCallbacks {
  vectorize: (content: string, metadata: Record<string, unknown>) => Promise<void>;
  deleteVectors: (field: string, value: string) => void;
}

export interface ConnectorPlugin extends PluginManifest {
  type: 'connector';
  initialize(config: Record<string, unknown>, callbacks: ConnectorCallbacks): Promise<void>;
  index(): Promise<void>;
  watch?(onChange: () => void): void;
  stop?(): Promise<void>;
}

export type Plugin = ChannelPlugin | ConnectorPlugin;

export interface PluginSetupQuestion {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'password';
  default?: string;
  required?: boolean;
}

export interface PluginConfig {
  name: string;
  package: string;
  type: 'channel' | 'connector';
  enabled: boolean;
  config: Record<string, unknown>;
}
