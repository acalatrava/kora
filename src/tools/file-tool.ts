import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import type { ToolDefinition, SandboxMount } from '../core/types.js';
import type { SandboxProvider } from './sandbox.js';
import { logger } from '../core/logger.js';

const SCOPE = 'file-tool';
const MAX_OUTPUT_CHARS = 100_000;

export interface FileToolContext {
  allowedPaths?: string[];
  sandboxProvider?: SandboxProvider;
  sandboxConfig?: {
    mounts: SandboxMount[];
    networkAccess: boolean;
    memoryLimitMb: number;
    image?: string;
    storagePath?: string;
  };
}

function isPathAllowed(filePath: string, allowedPaths?: string[]): boolean {
  if (!allowedPaths || allowedPaths.length === 0) return true;
  let resolved = resolve(filePath);
  try { resolved = realpathSync(resolved); } catch { /* path may not exist yet (writes) */ }
  return allowedPaths.some(p => {
    let allowed = resolve(p);
    try { allowed = realpathSync(allowed); } catch { /* ok */ }
    return resolved === allowed || resolved.startsWith(allowed + '/');
  });
}

export const fileToolDefinitions: ToolDefinition[] = [
  {
    name: 'file_list',
    description: 'List contents of a directory. Returns file names, types (file/dir), and sizes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_info',
    description: 'Get file information: number of lines (for text files) and size in bytes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write_text',
    description: 'Create a new text file with the given content. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path for the new file' },
        content: { type: 'string', description: 'Text content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_read_text',
    description: 'Read text content from a file. Supports reading specific line ranges with skip and read parameters.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        skip: { type: 'number', description: 'Number of lines to skip from the beginning (default: 0)' },
        read: { type: 'number', description: 'Number of lines to read (default: all remaining)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_edit_text',
    description: 'Edit a text file by inserting, replacing, or deleting lines at a specific position. Use skip to specify the line number (0-based) where the edit starts. Provide content to insert/replace lines, and delete to specify how many existing lines to remove at that position.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit' },
        skip: { type: 'number', description: 'Line number (0-based) where the edit starts' },
        content: { type: 'string', description: 'New content to insert at the position (after deleting lines if delete > 0)' },
        delete: { type: 'number', description: 'Number of lines to delete starting at the skip position (default: 0)' },
      },
      required: ['path', 'skip'],
    },
  },
  {
    name: 'file_delete',
    description: 'Delete a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to delete' },
      },
      required: ['path'],
    },
  },
];

async function sandboxExec(
  command: string,
  provider: SandboxProvider,
  config: FileToolContext['sandboxConfig'],
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const result = await provider.execute(command, {
    timeout: 15_000,
    mounts: config?.mounts ?? [],
    networkAccess: false,
    memoryLimitMb: config?.memoryLimitMb ?? 256,
    image: config?.image,
    storagePath: config?.storagePath,
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

function escapeShellArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function handleFileTool(
  name: string,
  args: Record<string, unknown>,
  context: FileToolContext,
): Promise<string> {
  const useSandbox = !!(context.sandboxProvider && context.sandboxConfig);

  try {
    switch (name) {
      case 'file_list': {
        const dirPath = args.path as string;
        if (!dirPath) return JSON.stringify({ ok: false, error: 'path is required' });

        if (!isPathAllowed(dirPath, context.allowedPaths)) {
          return JSON.stringify({ ok: false, error: `Path "${dirPath}" is outside allowed paths` });
        }

        if (useSandbox) {
          const r = await sandboxExec(
            `ls -lAh --time-style=long-iso ${escapeShellArg(dirPath)} 2>/dev/null || ls -lAh ${escapeShellArg(dirPath)} 2>/dev/null`,
            context.sandboxProvider!, context.sandboxConfig,
          );
          return JSON.stringify({ ok: r.ok, output: r.stdout || r.stderr });
        }
        const resolved = resolve(dirPath);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          return JSON.stringify({ ok: false, error: `Directory not found: ${dirPath}` });
        }
        const entries = readdirSync(resolved, { withFileTypes: true });
        const items = entries.map(e => {
          const fullPath = join(resolved, e.name);
          try {
            const st = statSync(fullPath);
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: st.size };
          } catch {
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: 0 };
          }
        });
        return JSON.stringify({ ok: true, path: resolved, entries: items });
      }

      case 'file_info': {
        const filePath = args.path as string;
        if (!filePath) return JSON.stringify({ ok: false, error: 'path is required' });

        if (!isPathAllowed(filePath, context.allowedPaths)) {
          return JSON.stringify({ ok: false, error: `Path "${filePath}" is outside allowed paths` });
        }

        if (useSandbox) {
          const r = await sandboxExec(
            `wc -l < ${escapeShellArg(filePath)} && wc -c < ${escapeShellArg(filePath)}`,
            context.sandboxProvider!, context.sandboxConfig,
          );
          if (r.ok) {
            const parts = r.stdout.trim().split('\n');
            const lines = parseInt(parts[0]?.trim() || '0', 10);
            const bytes = parseInt(parts[1]?.trim() || '0', 10);
            return JSON.stringify({ ok: true, path: filePath, lines, bytes });
          }
          return JSON.stringify({ ok: false, error: r.stderr || 'File not found' });
        }
        const resolved = resolve(filePath);
        if (!existsSync(resolved)) {
          return JSON.stringify({ ok: false, error: `File not found: ${filePath}` });
        }
        const st = statSync(resolved);
        let lines = 0;
        if (st.isFile()) {
          const content = readFileSync(resolved, 'utf-8');
          lines = content.split('\n').length;
        }
        return JSON.stringify({ ok: true, path: resolved, lines, bytes: st.size });
      }

      case 'file_write_text': {
        const filePath = args.path as string;
        const content = args.content as string;
        if (!filePath) return JSON.stringify({ ok: false, error: 'path is required' });
        if (content === undefined || content === null) return JSON.stringify({ ok: false, error: 'content is required' });

        if (!isPathAllowed(filePath, context.allowedPaths)) {
          return JSON.stringify({ ok: false, error: `Path "${filePath}" is outside allowed paths` });
        }

        if (useSandbox) {
          const dir = dirname(filePath);
          const b64 = Buffer.from(content, 'utf-8').toString('base64');
          const r = await sandboxExec(
            `mkdir ${escapeShellArg(dir)} && echo ${escapeShellArg(b64)} | base64 -d > ${escapeShellArg(filePath)}`,
            context.sandboxProvider!, context.sandboxConfig,
          );
          if (!r.ok) return JSON.stringify({ ok: false, error: r.stderr || 'Failed to create file' });
          return JSON.stringify({ ok: true, path: filePath, bytes: Buffer.byteLength(content, 'utf-8') });
        }
        const resolved = resolve(filePath);
        mkdirSync(dirname(resolved), { recursive: true });
        writeFileSync(resolved, content, 'utf-8');
        logger.info(SCOPE, `Created file: ${resolved} (${Buffer.byteLength(content, 'utf-8')} bytes)`);
        return JSON.stringify({ ok: true, path: resolved, bytes: Buffer.byteLength(content, 'utf-8') });
      }

      case 'file_read_text': {
        const filePath = args.path as string;
        const skip = (args.skip as number) || 0;
        const readCount = args.read as number | undefined;
        if (!filePath) return JSON.stringify({ ok: false, error: 'path is required' });

        if (!isPathAllowed(filePath, context.allowedPaths)) {
          return JSON.stringify({ ok: false, error: `Path "${filePath}" is outside allowed paths` });
        }

        if (useSandbox) {
          let cmd: string;
          if (readCount !== undefined) {
            cmd = `tail -n +${skip + 1} ${escapeShellArg(filePath)} | head -n ${readCount}`;
          } else if (skip > 0) {
            cmd = `tail -n +${skip + 1} ${escapeShellArg(filePath)}`;
          } else {
            cmd = `cat ${escapeShellArg(filePath)}`;
          }
          const r = await sandboxExec(cmd, context.sandboxProvider!, context.sandboxConfig);
          if (!r.ok) return JSON.stringify({ ok: false, error: r.stderr || 'Failed to read file' });
          const output = r.stdout.length > MAX_OUTPUT_CHARS
            ? r.stdout.slice(0, MAX_OUTPUT_CHARS) + '\n... [truncated]'
            : r.stdout;
          return JSON.stringify({ ok: true, content: output, skipped: skip });
        }
        const resolved = resolve(filePath);
        if (!existsSync(resolved)) {
          return JSON.stringify({ ok: false, error: `File not found: ${filePath}` });
        }
        const allLines = readFileSync(resolved, 'utf-8').split('\n');
        const sliced = readCount !== undefined
          ? allLines.slice(skip, skip + readCount)
          : allLines.slice(skip);
        let text = sliced.join('\n');
        if (text.length > MAX_OUTPUT_CHARS) {
          text = text.slice(0, MAX_OUTPUT_CHARS) + '\n... [truncated]';
        }
        return JSON.stringify({ ok: true, content: text, totalLines: allLines.length, skipped: skip, linesReturned: sliced.length });
      }

      case 'file_edit_text': {
        const filePath = args.path as string;
        const skip = args.skip as number;
        const newContent = args.content as string | undefined;
        const deleteCount = (args.delete as number) || 0;
        if (!filePath) return JSON.stringify({ ok: false, error: 'path is required' });
        if (skip === undefined || skip === null) return JSON.stringify({ ok: false, error: 'skip is required' });
        if (!newContent && deleteCount <= 0) return JSON.stringify({ ok: false, error: 'Provide content to insert or delete > 0' });

        if (!isPathAllowed(filePath, context.allowedPaths)) {
          return JSON.stringify({ ok: false, error: `Path "${filePath}" is outside allowed paths` });
        }

        if (useSandbox) {
          const readResult = await sandboxExec(`cat ${escapeShellArg(filePath)}`, context.sandboxProvider!, context.sandboxConfig);
          if (!readResult.ok) return JSON.stringify({ ok: false, error: readResult.stderr || 'Cannot read file for editing' });

          const lines = readResult.stdout.split('\n');
          const before = lines.slice(0, skip);
          const after = lines.slice(skip + deleteCount);
          const newLines = newContent ? newContent.split('\n') : [];
          const result = [...before, ...newLines, ...after].join('\n');

          const b64Edit = Buffer.from(result, 'utf-8').toString('base64');
          const writeResult = await sandboxExec(
            `echo ${escapeShellArg(b64Edit)} | base64 -d > ${escapeShellArg(filePath)}`,
            context.sandboxProvider!, context.sandboxConfig,
          );
          if (!writeResult.ok) return JSON.stringify({ ok: false, error: writeResult.stderr || 'Failed to write edited file' });
          return JSON.stringify({ ok: true, linesDeleted: deleteCount, linesInserted: newLines.length });
        }
        const resolved = resolve(filePath);
        if (!existsSync(resolved)) {
          return JSON.stringify({ ok: false, error: `File not found: ${filePath}` });
        }
        const lines = readFileSync(resolved, 'utf-8').split('\n');
        const before = lines.slice(0, skip);
        const after = lines.slice(skip + deleteCount);
        const newLines = newContent ? newContent.split('\n') : [];
        writeFileSync(resolved, [...before, ...newLines, ...after].join('\n'), 'utf-8');
        logger.info(SCOPE, `Edited file: ${resolved} (deleted ${deleteCount}, inserted ${newLines.length} lines at ${skip})`);
        return JSON.stringify({ ok: true, linesDeleted: deleteCount, linesInserted: newLines.length });
      }

      case 'file_delete': {
        const filePath = args.path as string;
        if (!filePath) return JSON.stringify({ ok: false, error: 'path is required' });

        if (!isPathAllowed(filePath, context.allowedPaths)) {
          return JSON.stringify({ ok: false, error: `Path "${filePath}" is outside allowed paths` });
        }

        if (useSandbox) {
          const r = await sandboxExec(`rm ${escapeShellArg(filePath)}`, context.sandboxProvider!, context.sandboxConfig);
          if (!r.ok) return JSON.stringify({ ok: false, error: r.stderr || 'Failed to delete file' });
          return JSON.stringify({ ok: true, deleted: filePath });
        }
        const resolved = resolve(filePath);
        if (!existsSync(resolved)) {
          return JSON.stringify({ ok: false, error: `File not found: ${filePath}` });
        }
        unlinkSync(resolved);
        logger.info(SCOPE, `Deleted file: ${resolved}`);
        return JSON.stringify({ ok: true, deleted: resolved });
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown file tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(SCOPE, `File tool "${name}" failed: ${msg}`);
    return JSON.stringify({ ok: false, error: msg });
  }
}
