import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ConfigManager } from './config.js';
import { logger } from './logger.js';

const SCOPE = 'memory';
const ENTRY_HEADER = /^## \[mem-([a-z0-9]+)\] (.+)$/;

export interface MemoryEntry {
  id: string;
  timestamp: string;
  content: string;
}

function generateId(): string {
  return crypto.randomBytes(4).toString('hex');
}

export class MemoryManager {
  private configManager: ConfigManager;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
  }

  private memoryPath(workspaceId: string): string {
    return path.join(this.configManager.getWorkspacePath(workspaceId), 'MEMORY.md');
  }

  load(workspaceId: string): string {
    const filePath = this.memoryPath(workspaceId);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf-8');
  }

  save(workspaceId: string, content: string): void {
    const filePath = this.memoryPath(workspaceId);
    this.configManager.ensureWorkspaceDir(workspaceId);
    fs.writeFileSync(filePath, content, 'utf-8');
    logger.debug(SCOPE, `Saved MEMORY.md for workspace ${workspaceId}`);
  }

  parseEntries(workspaceId: string): MemoryEntry[] {
    const raw = this.load(workspaceId);
    if (!raw.trim()) return [];

    const lines = raw.split('\n');
    const entries: MemoryEntry[] = [];
    let current: MemoryEntry | null = null;

    for (const line of lines) {
      const match = line.match(ENTRY_HEADER);
      if (match) {
        if (current) entries.push(current);
        current = { id: match[1], timestamp: match[2], content: '' };
      } else if (current) {
        current.content += (current.content ? '\n' : '') + line;
      } else if (line.trim()) {
        const legacyMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*(.+)$/);
        if (legacyMatch) {
          entries.push({
            id: generateId(),
            timestamp: legacyMatch[1],
            content: legacyMatch[2],
          });
        } else {
          entries.push({
            id: generateId(),
            timestamp: new Date().toISOString(),
            content: line.trim(),
          });
        }
      }
    }
    if (current) entries.push(current);

    for (const e of entries) {
      e.content = e.content.trim();
    }

    return entries.filter(e => e.content.length > 0);
  }

  private serializeEntries(entries: MemoryEntry[]): string {
    return entries.map(e =>
      `## [mem-${e.id}] ${e.timestamp}\n${e.content}`
    ).join('\n\n') + '\n';
  }

  append(workspaceId: string, entry: string): MemoryEntry {
    const entries = this.parseEntries(workspaceId);
    const newEntry: MemoryEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      content: entry.trim(),
    };
    entries.push(newEntry);
    this.save(workspaceId, this.serializeEntries(entries));
    logger.debug(SCOPE, `Appended entry mem-${newEntry.id} for workspace ${workspaceId}`);
    return newEntry;
  }

  update(workspaceId: string, entryId: string, newContent: string): boolean {
    const entries = this.parseEntries(workspaceId);
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return false;
    entry.content = newContent.trim();
    this.save(workspaceId, this.serializeEntries(entries));
    logger.debug(SCOPE, `Updated entry mem-${entryId} for workspace ${workspaceId}`);
    return true;
  }

  remove(workspaceId: string, entryId: string): boolean {
    const entries = this.parseEntries(workspaceId);
    const idx = entries.findIndex(e => e.id === entryId);
    if (idx === -1) return false;
    entries.splice(idx, 1);
    this.save(workspaceId, entries.length > 0 ? this.serializeEntries(entries) : '');
    logger.debug(SCOPE, `Removed entry mem-${entryId} from workspace ${workspaceId}`);
    return true;
  }

  list(workspaceId: string): MemoryEntry[] {
    return this.parseEntries(workspaceId);
  }

  getContextSnippet(workspaceId: string, maxChars = 8000): string {
    const entries = this.parseEntries(workspaceId);
    if (entries.length === 0) return '';

    const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const lines: string[] = [];
    let totalLen = 0;

    for (const e of sorted) {
      const line = `<memory-entry id="mem-${e.id}" timestamp="${e.timestamp}">${e.content}</memory-entry>`;
      if (totalLen + line.length > maxChars) break;
      lines.push(line);
      totalLen += line.length + 1;
    }

    return lines.join('\n');
  }
}
