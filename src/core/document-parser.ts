import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { logger } from './logger.js';

const SCOPE = 'document-parser';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.yml', '.yaml', '.xml', '.csv', '.log', '.js', '.ts',
  '.py', '.rb', '.sh', '.bash', '.html', '.css', '.sql', '.java', '.c', '.cpp',
  '.h', '.rs', '.go', '.php', '.swift', '.kt', '.toml', '.ini', '.cfg', '.env',
  '.conf', '.makefile', '.dockerfile', '.tsx', '.jsx', '.vue', '.svelte',
]);

const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/html', 'text/css', 'text/csv',
  'text/xml', 'text/javascript', 'text/x-python', 'text/x-yaml',
  'application/json', 'application/xml', 'application/javascript',
  'application/typescript', 'application/x-yaml', 'application/yaml',
  'application/csv', 'application/x-sh',
]);

export interface ParsedDocument {
  text: string;
  pages?: number;
  method: 'text' | 'pdf' | 'docx' | 'ocr';
}

export async function parseDocument(
  filePath: string,
  mimeType?: string,
  fileName?: string,
): Promise<ParsedDocument | null> {
  const ext = extname(fileName || filePath).toLowerCase();

  if (isPdf(ext, mimeType)) {
    return parsePdf(filePath);
  }

  if (isDocx(ext, mimeType)) {
    return parseDocx(filePath);
  }

  if (isImage(ext, mimeType)) {
    return parseImageOcr(filePath);
  }

  if (isTextFile(ext, mimeType)) {
    return parseTextFile(filePath);
  }

  return null;
}

function isPdf(ext: string, mime?: string): boolean {
  return ext === '.pdf' || mime === 'application/pdf';
}

function isDocx(ext: string, mime?: string): boolean {
  return ext === '.docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

function isImage(ext: string, mime?: string): boolean {
  if (mime?.startsWith('image/')) return true;
  return ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.webp'].includes(ext);
}

function isTextFile(ext: string, mime?: string): boolean {
  if (mime && TEXT_MIMES.has(mime)) return true;
  if (mime?.startsWith('text/')) return true;
  return TEXT_EXTENSIONS.has(ext);
}

function parseTextFile(filePath: string): ParsedDocument | null {
  try {
    const text = readFileSync(filePath, 'utf-8');
    if (text.length === 0) return null;
    return { text, method: 'text' };
  } catch {
    return null;
  }
}

async function parsePdf(filePath: string): Promise<ParsedDocument | null> {
  try {
    const mod = await import('pdf-parse') as any;
    const buffer = readFileSync(filePath);
    const PDFParse = mod.PDFParse ?? mod.default;
    const pdf = new PDFParse({ data: buffer });
    const result = await pdf.getText();
    const text = typeof result === 'string' ? result : (result?.text ?? '');
    if (!text || text.trim().length === 0) return null;
    const doc = await pdf.load();
    const pages = doc?.numPages ?? 0;
    return { text, pages, method: 'pdf' };
  } catch (err) {
    logger.warn(SCOPE, `PDF parse failed for ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

async function parseDocx(filePath: string): Promise<ParsedDocument | null> {
  try {
    const mammoth = await import('mammoth') as any;
    const buffer = readFileSync(filePath);
    const fn = mammoth.extractRawText ?? mammoth.default?.extractRawText;
    if (!fn) throw new Error('mammoth.extractRawText not found');
    const result = await fn({ buffer });
    if (!result.value || result.value.trim().length === 0) return null;
    return { text: result.value, method: 'docx' };
  } catch (err) {
    logger.warn(SCOPE, `DOCX parse failed for ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

async function parseImageOcr(filePath: string): Promise<ParsedDocument | null> {
  try {
    const Tesseract = await import('tesseract.js') as any;
    const createWorker = Tesseract.createWorker ?? Tesseract.default?.createWorker;
    if (!createWorker) throw new Error('tesseract.js createWorker not found');
    const worker = await createWorker('eng');
    const { data } = await worker.recognize(filePath);
    await worker.terminate();
    if (!data.text || data.text.trim().length === 0) return null;
    return { text: data.text, method: 'ocr' };
  } catch (err) {
    logger.warn(SCOPE, `OCR failed for ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

export function canParse(mimeType?: string, fileName?: string): boolean {
  const ext = extname(fileName || '').toLowerCase();
  return isPdf(ext, mimeType) || isDocx(ext, mimeType) ||
    isImage(ext, mimeType) || isTextFile(ext, mimeType);
}
