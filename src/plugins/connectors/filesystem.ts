import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../core/logger.js';
import type { ConnectorPlugin, ConnectorCallbacks } from '../types.js';

const SCOPE = 'connector-fs';

const SUPPORTED_TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.log', '.ini', '.cfg', '.conf',
  '.js', '.ts', '.py', '.sh', '.bash', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.css', '.sql',
]);

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_TEXT_EXTENSIONS.has(ext);
}

function walkDir(dir: string, extensions?: Set<string>): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results.push(...walkDir(fullPath, extensions));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions) {
        if (extensions.has(ext)) results.push(fullPath);
      } else if (isTextFile(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

export interface FilesystemConnectorConfig {
  path: string;
  watch?: boolean;
  extensions?: string[];
  maxFileSizeKb?: number;
}

export class FilesystemConnector implements ConnectorPlugin {
  readonly name = 'filesystem';
  readonly version = '1.0.0';
  readonly type = 'connector' as const;
  readonly description = 'Index text files from a local directory into the knowledge base';

  private config: FilesystemConnectorConfig = { path: '' };
  private callbacks: ConnectorCallbacks | null = null;
  private watcher: fs.FSWatcher | null = null;
  private extensionSet: Set<string> | undefined;
  private indexedFiles = new Set<string>();

  async initialize(config: Record<string, unknown>, callbacks: ConnectorCallbacks): Promise<void> {
    this.config = {
      path: String(config.path || ''),
      watch: config.watch === true,
      extensions: Array.isArray(config.extensions) ? config.extensions.map(String) : undefined,
      maxFileSizeKb: typeof config.maxFileSizeKb === 'number' ? config.maxFileSizeKb : 512,
    };
    this.callbacks = callbacks;

    if (this.config.extensions) {
      this.extensionSet = new Set(this.config.extensions.map(e => e.startsWith('.') ? e : `.${e}`));
    }

    if (!this.config.path || !fs.existsSync(this.config.path)) {
      throw new Error(`Directory not found: ${this.config.path}`);
    }

    logger.info(SCOPE, `Initialized for directory: ${this.config.path}`);
  }

  async index(): Promise<void> {
    if (!this.callbacks) throw new Error('Connector not initialized');

    const files = walkDir(this.config.path, this.extensionSet);
    const maxBytes = (this.config.maxFileSizeKb ?? 512) * 1024;
    let indexed = 0;

    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > maxBytes) continue;

        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) continue;

        const relativePath = path.relative(this.config.path, filePath);
        this.callbacks.deleteVectors('connectorFile', relativePath);

        await this.callbacks.vectorize(content, {
          type: 'connector',
          connector: this.name,
          connectorFile: relativePath,
          fileName: path.basename(filePath),
          fullPath: filePath,
        });

        this.indexedFiles.add(filePath);
        indexed++;
      } catch (err) {
        logger.warn(SCOPE, `Failed to index ${filePath}: ${(err as Error).message}`);
      }
    }

    logger.info(SCOPE, `Indexed ${indexed} files from ${this.config.path}`);
  }

  watch(onChange: () => void): void {
    if (!this.config.watch || !this.config.path) return;

    try {
      this.watcher = fs.watch(this.config.path, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(this.config.path, filename);
        const ext = path.extname(filename).toLowerCase();
        const isRelevant = this.extensionSet ? this.extensionSet.has(ext) : isTextFile(fullPath);
        if (!isRelevant) return;

        logger.debug(SCOPE, `File change detected: ${eventType} ${filename}`);
        onChange();
      });
      logger.info(SCOPE, `Watching for changes in ${this.config.path}`);
    } catch (err) {
      logger.warn(SCOPE, `Failed to set up file watcher: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    logger.info(SCOPE, 'Filesystem connector stopped');
  }
}

export function createFilesystemConnector(): FilesystemConnector {
  return new FilesystemConnector();
}
