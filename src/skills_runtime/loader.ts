import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import matter from 'gray-matter';
import type { SkillManifest, SkillRequirements } from '../core/types.js';
import { logger } from '../core/logger.js';

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  compatibility?: string;
  homepage?: string;
  metadata?: string | Record<string, unknown>;
}

function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return undefined; }
  }
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  return undefined;
}

function extractRequirements(meta: Record<string, unknown> | undefined): SkillRequirements | undefined {
  if (!meta) return undefined;
  const clawdbot = meta.clawdbot as Record<string, unknown> | undefined;
  const requires = clawdbot?.requires as Record<string, unknown> | undefined;
  if (!requires) return undefined;

  const bins = Array.isArray(requires.bins) ? requires.bins.filter((b): b is string => typeof b === 'string') : undefined;
  const env = Array.isArray(requires.env) ? requires.env.filter((e): e is string => typeof e === 'string') : undefined;

  return (bins?.length || env?.length) ? { bins, env } : undefined;
}

export function loadSkill(skillPath: string): SkillManifest | null {
  try {
    const content = readFileSync(skillPath, 'utf-8');
    const { data, content: body } = matter(content);
    const fm = data as SkillFrontmatter;

    if (!fm.name || !fm.description) {
      logger.warn('skills', `Skipping ${skillPath}: missing required frontmatter fields (name, description)`);
      return null;
    }

    const skillDir = dirname(skillPath);
    const meta = parseMetadata(fm.metadata);
    const clawdbot = meta?.clawdbot as Record<string, unknown> | undefined;

    const manifest: SkillManifest = {
      name: fm.name,
      description: fm.description,
      version: fm.version ?? (meta?.version as string | undefined),
      author: fm.author ?? (meta?.author as string | undefined),
      license: fm.license,
      compatibility: fm.compatibility,
      homepage: fm.homepage ?? (meta?.homepage as string | undefined),
      emoji: (clawdbot?.emoji as string | undefined),
      metadata: meta,
      requires: extractRequirements(meta),
      dirPath: skillDir,
    };

    if (body.trim().length > 0) {
      manifest.instructions = body.trim();
    }

    const extraDirs = ['scripts', 'references', 'assets'];
    const available = extraDirs.filter(d => existsSync(join(skillDir, d)));
    const label = [
      manifest.version ? `v${manifest.version}` : null,
      `${body.trim().length} chars`,
      available.length ? `dirs: ${available.join(', ')}` : null,
      manifest.requires ? `requires: ${[...(manifest.requires.bins ?? []), ...(manifest.requires.env ?? [])].join(', ')}` : null,
    ].filter(Boolean).join(', ');

    logger.debug('skills', `Loaded skill "${manifest.name}" (${label})`);
    return manifest;
  } catch (err) {
    logger.error('skills', `Failed to load skill from ${skillPath}: ${(err as Error).message}`);
    return null;
  }
}

export function loadAllSkills(skillsDir: string): SkillManifest[] {
  const manifests: SkillManifest[] = [];

  try {
    const entries = readdirSync(skillsDir);

    for (const entry of entries) {
      const entryPath = join(skillsDir, entry);
      const stat = statSync(entryPath);

      if (stat.isDirectory()) {
        const skillFile = join(entryPath, 'SKILL.md');
        try {
          statSync(skillFile);
          const manifest = loadSkill(skillFile);
          if (manifest) manifests.push(manifest);
        } catch {
          logger.debug('skills', `No SKILL.md found in ${entryPath}, skipping`);
        }
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger.debug('skills', `Skills directory does not exist: ${skillsDir}`);
    } else {
      logger.error('skills', `Failed to scan skills directory ${skillsDir}: ${(err as Error).message}`);
    }
  }

  if (manifests.length > 0) {
    logger.debug('skills', `Loaded ${manifests.length} skill(s) from ${skillsDir}`);
  }
  return manifests;
}
