import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import type { ToolDefinition } from '../core/types.js';
import type { VectorStore } from '../core/vector-store.js';
import type { EmbeddingProvider } from '../core/vector-store.js';
import { generateVectorId } from '../core/vector-store.js';
import { parseDocument, canParse } from '../core/document-parser.js';
import { logger } from '../core/logger.js';

const SCOPE = 'knowledge-tool';

export interface KnowledgeToolContext {
  vectorStore?: VectorStore;
  embeddingProvider?: EmbeddingProvider;
  workspacePath?: string;
}

function chunkText(text: string, maxChunkSize = 10000): string[] {
  if (text.length <= maxChunkSize) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChunkSize, text.length);
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      if (lastNewline > start + maxChunkSize * 0.5) end = lastNewline + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export const knowledgeToolDefinitions: ToolDefinition[] = [
  {
    name: 'knowledge_search',
    description: 'Search the user\'s document knowledge base (previously sent files: text, PDF, DOCX, images with OCR). Returns the most relevant document excerpts. Use this when the user asks about content from their uploaded documents, or when the auto-injected context is not sufficient.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — describe what you are looking for' },
        top_k: { type: 'number', description: 'Number of results to return (default: 10, max: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'knowledge_list',
    description: 'List all documents stored in the knowledge base with metadata (file name, type, date). Use this to see what documents the user has uploaded.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_transcript',
    description: 'Retrieve a full session transcript by its timestamp ID. Transcripts contain user questions and agent responses from past sessions.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The transcript timestamp ID (e.g. "20260306-153012")' },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_ingest',
    description: 'Import a file into the knowledge base for RAG retrieval. Supports text, PDF, DOCX, code files, and images (OCR). Use this after downloading a file to make its content searchable.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to ingest' },
        description: { type: 'string', description: 'Optional description or context about the document' },
      },
      required: ['file_path'],
    },
  },
];

export async function handleKnowledgeTool(
  name: string,
  args: Record<string, unknown>,
  context: KnowledgeToolContext,
): Promise<string> {
  if (!context.vectorStore || !context.embeddingProvider) {
    return JSON.stringify({ ok: false, error: 'Knowledge base is not available' });
  }

  try {
    switch (name) {
      case 'knowledge_search': {
        const query = args.query as string;
        if (!query) return JSON.stringify({ ok: false, error: 'query is required' });
        const topK = Math.min(Math.max((args.top_k as number) || 10, 1), 20);

        const count = context.vectorStore.count();
        if (count === 0) {
          return JSON.stringify({ ok: true, results: [], message: 'Knowledge base is empty. No documents have been uploaded yet.' });
        }

        const embedding = await context.embeddingProvider.embed(query);
        const results = context.vectorStore.search(embedding, topK, 0.01);

        const formatted = results.map(r => ({
          score: parseFloat(r.score.toFixed(3)),
          fileName: r.document.metadata?.fileName ?? null,
          parseMethod: r.document.metadata?.parseMethod ?? 'text',
          excerpt: r.document.content.slice(0, 500),
          fullContent: r.document.content,
          date: r.document.createdAt.toISOString(),
        }));

        return JSON.stringify({ ok: true, query, totalDocuments: count, results: formatted });
      }

      case 'knowledge_list': {
        const count = context.vectorStore.count();
        if (count === 0) {
          return JSON.stringify({ ok: true, documents: [], message: 'Knowledge base is empty.' });
        }

        const allDocs = context.vectorStore.listAll();
        const grouped = new Map<string, { fileName: string; method: string; chunks: number; date: string }>();
        for (const doc of allDocs) {
          const key = (doc.metadata?.fileName as string) || doc.id;
          const existing = grouped.get(key);
          if (existing) {
            existing.chunks++;
          } else {
            grouped.set(key, {
              fileName: (doc.metadata?.fileName as string) || 'unknown',
              method: (doc.metadata?.parseMethod as string) || 'text',
              chunks: 1,
              date: doc.createdAt.toISOString(),
            });
          }
        }

        return JSON.stringify({
          ok: true,
          totalChunks: count,
          documents: Array.from(grouped.values()),
        });
      }

      case 'get_transcript': {
        const id = args.id as string;
        if (!id) return JSON.stringify({ ok: false, error: 'id is required' });
        if (!context.workspacePath) return JSON.stringify({ ok: false, error: 'Transcripts not available' });

        const transcriptsDir = join(context.workspacePath, 'transcripts');
        if (!existsSync(transcriptsDir)) {
          return JSON.stringify({ ok: true, content: null, message: 'No transcripts found.' });
        }

        const files = readdirSync(transcriptsDir).filter(f => f.includes(id) && f.endsWith('.md'));
        if (files.length === 0) {
          return JSON.stringify({ ok: true, content: null, message: `No transcript found for id "${id}".` });
        }

        const content = readFileSync(join(transcriptsDir, files[0]), 'utf-8');
        return JSON.stringify({ ok: true, id, content });
      }

      case 'knowledge_ingest': {
        const filePath = args.file_path as string;
        if (!filePath) return JSON.stringify({ ok: false, error: 'file_path is required' });
        if (!existsSync(filePath)) return JSON.stringify({ ok: false, error: `File not found: ${filePath}` });

        const fileName = basename(filePath);
        const mimeType = guessMimeType(fileName);

        if (!canParse(mimeType, fileName)) {
          return JSON.stringify({ ok: false, error: `Unsupported file type: ${fileName}` });
        }

        const parsed = await parseDocument(filePath, mimeType, fileName);
        if (!parsed || parsed.text.length === 0) {
          return JSON.stringify({ ok: false, error: 'Could not extract text from the file' });
        }
        if (parsed.text.length > 1_000_000) {
          return JSON.stringify({ ok: false, error: `File too large (${parsed.text.length} chars). Maximum is 1,000,000 characters.` });
        }

        const description = (args.description as string) || undefined;
        const metadata: Record<string, unknown> = {
          fileName,
          mimeType,
          parseMethod: parsed.method,
          source: 'knowledge_ingest',
          ...(parsed.pages && { pages: parsed.pages }),
          ...(description && { description }),
        };

        const chunks = chunkText(parsed.text);
        let inserted = 0;
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await context.embeddingProvider!.embed(chunks[i]);
          context.vectorStore!.insert({
            id: generateVectorId(),
            content: chunks[i],
            embedding,
            metadata: { ...metadata, chunkIndex: i, totalChunks: chunks.length },
          });
          inserted++;
        }

        logger.info(SCOPE, `Ingested "${fileName}" into knowledge base (${inserted} chunks, ${parsed.text.length} chars)`);
        return JSON.stringify({
          ok: true,
          message: `File "${fileName}" ingested successfully`,
          fileName,
          parseMethod: parsed.method,
          textLength: parsed.text.length,
          chunks: inserted,
        });
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown knowledge tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `Knowledge tool "${name}" failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.yml': 'text/yaml', '.yaml': 'text/yaml', '.xml': 'text/xml',
  '.html': 'text/html', '.css': 'text/css', '.sql': 'text/plain',
  '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
  '.rb': 'text/x-ruby', '.go': 'text/x-go', '.java': 'text/x-java',
  '.c': 'text/x-c', '.cpp': 'text/x-c++', '.rs': 'text/x-rust',
  '.php': 'text/x-php', '.swift': 'text/x-swift', '.kt': 'text/x-kotlin', '.sh': 'text/x-sh',
  '.toml': 'text/toml', '.ini': 'text/plain', '.cfg': 'text/plain', '.env': 'text/plain', '.conf': 'text/plain',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.webp': 'image/webp',
};

function guessMimeType(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}
