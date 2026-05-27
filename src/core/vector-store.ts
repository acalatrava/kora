import path from 'node:path';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';

export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface SearchResult {
  document: VectorDocument;
  score: number;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

interface VectorRow {
  id: string;
  content: string;
  embedding: string;
  metadata: string | null;
  created_at: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

export class VectorStore {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    logger.debug('vector-store', `Opened vector store at ${dbPath}`);
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      )
    `);
    logger.info('vector-store', 'Vectors table initialized');
  }

  insert(doc: Omit<VectorDocument, 'createdAt'>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO vectors (id, content, embedding, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      doc.id,
      doc.content,
      JSON.stringify(doc.embedding),
      doc.metadata ? JSON.stringify(doc.metadata) : null,
      new Date().toISOString(),
    );

    logger.debug('vector-store', `Inserted vector ${doc.id}`);
  }

  search(queryEmbedding: number[], topK = 5, threshold = 0.0): SearchResult[] {
    const rows = this.db.prepare('SELECT * FROM vectors').all() as VectorRow[];

    const scored: SearchResult[] = [];

    for (const row of rows) {
      const embedding: number[] = JSON.parse(row.embedding);
      const score = cosineSimilarity(queryEmbedding, embedding);

      if (score >= threshold) {
        scored.push({
          document: {
            id: row.id,
            content: row.content,
            embedding,
            metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
            createdAt: new Date(row.created_at),
          },
          score,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM vectors WHERE id = ?').run(id);
    logger.debug('vector-store', `Deleted vector ${id}`);
  }

  deleteByMetadata(field: string, value: string): number {
    const rows = this.db.prepare('SELECT id, metadata FROM vectors WHERE metadata IS NOT NULL').all() as Array<{ id: string; metadata: string }>;
    let deleted = 0;
    const deleteStmt = this.db.prepare('DELETE FROM vectors WHERE id = ?');
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata) as Record<string, unknown>;
        if (String(meta[field] ?? '') === value) {
          deleteStmt.run(row.id);
          deleted++;
        }
      } catch { /* skip malformed metadata */ }
    }
    if (deleted > 0) {
      logger.debug('vector-store', `Deleted ${deleted} vectors where metadata.${field} = "${value}"`);
    }
    return deleted;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM vectors').get() as { cnt: number };
    return row.cnt;
  }

  listAll(): VectorDocument[] {
    const rows = this.db.prepare('SELECT id, content, metadata, created_at FROM vectors ORDER BY created_at DESC').all() as Array<{
      id: string; content: string; metadata: string | null; created_at: string;
    }>;
    return rows.map(r => ({
      id: r.id,
      content: r.content,
      embedding: [],
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      createdAt: new Date(r.created_at),
    }));
  }

  close(): void {
    this.db.close();
    logger.debug('vector-store', 'Vector store closed');
  }
}

/**
 * Hash-based local embedding provider for MVP use.
 * Produces deterministic vectors without external API calls.
 * Swap to LocalEmbeddingProvider or OpenAIEmbeddingProvider for better results.
 */
export class SimpleEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;

  async embed(text: string): Promise<number[]> {
    const vector = new Float64Array(this.dimensions);
    const tokens = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);

    for (const token of tokens) {
      const hash = this.hashToken(token);
      const idx = Math.abs(hash) % this.dimensions;
      const sign = hash > 0 ? 1 : -1;
      vector[idx] += sign;

      const idx2 = Math.abs(hash * 31) % this.dimensions;
      vector[idx2] += sign * 0.5;
    }

    return this.normalize(Array.from(vector));
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  private hashToken(token: string): number {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    }
    return hash;
  }

  private normalize(vector: number[]): number[] {
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    return vector.map((v) => v / norm);
  }
}

/**
 * Local ML embedding provider using all-MiniLM-L6-v2 via @huggingface/transformers.
 * Produces 384-dimension vectors with real semantic understanding.
 * No external API needed — runs entirely on the local machine.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  private extractor: any = null;
  private model: string;
  private initPromise: Promise<void> | null = null;

  constructor(model = 'Xenova/all-MiniLM-L6-v2') {
    this.model = model;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.extractor) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      logger.info('vector-store', `Loading local embedding model: ${this.model} (first run downloads ~80MB)`);
      this.extractor = await pipeline('feature-extraction', this.model, {
        dtype: 'fp32',
      });
      logger.info('vector-store', `Local embedding model loaded: ${this.model}`);
    })();

    return this.initPromise;
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureLoaded();
    const result = await this.extractor([text], { pooling: 'mean', normalize: true });
    return Array.from(result.data as Float32Array);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.ensureLoaded();
    const result = await this.extractor(texts, { pooling: 'mean', normalize: true });
    return result.tolist();
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  readonly dimensions: number;

  constructor(apiKey: string, model = 'text-embedding-3-small') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.dimensions = model === 'text-embedding-3-large' ? 3072 : 1536;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

/**
 * Embedding provider for OpenAI-compatible APIs (e.g. Ollama, LM Studio, vLLM).
 */
export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  readonly dimensions: number;

  constructor(baseUrl: string, model: string, apiKey = '', dimensions = 384) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.callApi([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.callApi(texts);
  }

  private async callApi(input: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model, input }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Embedding API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as { data: Array<{ index: number; embedding: number[] }> };
    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }
}

export function createVectorStore(workspacePath: string): VectorStore {
  const dbPath = path.join(workspacePath, 'vector.db');
  const store = new VectorStore(dbPath);
  store.initialize();
  return store;
}

export { uuidv4 as generateVectorId };
