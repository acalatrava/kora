import { EventEmitter } from 'eventemitter3';

export interface AuditEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  type: 'user_msg' | 'assistant_msg' | 'tool_call' | 'tool_result' | 'tool_exec' | 'llm_request' | 'llm_response' | 'system_prompt' | 'context_compaction' | 'error' | 'heartbeat' | 'system' | 'session_start' | 'session_end' | 'notify';
  channel: string;
  identityId: string;
  workspaceId: string;
  data: Record<string, unknown>;
  durationMs?: number;
}

export interface EventMap {
  audit_entry: (entry: AuditEntry) => void;
}

export const eventBus = new EventEmitter<EventMap>();
