export interface DelegatedEmail {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  hasAttachments: boolean;
}

export interface DelegatedEmailDetail extends DelegatedEmail {
  body: string;
  htmlBody?: string;
  attachments: Array<{ filename: string; mimeType: string; size: number; localPath?: string }>;
}

export interface DelegationPermissions {
  read: boolean;
  send: boolean;
}

export interface DelegationCredentials {
  refreshToken?: string;
  imap?: { host: string; port: number; user: string; password: string; tls: boolean };
  smtp?: { host: string; port: number; user: string; password: string; secure: boolean };
}

export interface DelegationConfig {
  id: string;
  workspaceId: string;
  provider: 'gmail' | 'imap';
  email: string;
  credentials: DelegationCredentials;
  permissions: DelegationPermissions;
  autoCheckMinutes: number;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface DelegationGlobalConfig {
  google_client_id?: string;
  google_client_secret?: string;
}
