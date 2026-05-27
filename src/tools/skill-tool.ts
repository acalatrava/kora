import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { ToolDefinition, SkillRequirements } from '../core/types.js';
import type { SkillRegistry } from '../skills_runtime/registry.js';
import { loadSkill } from '../skills_runtime/loader.js';
import { logger } from '../core/logger.js';
import { ConfigManager } from 'src/index.js';

export interface SkillToolContext {
  skillRegistry: SkillRegistry;
  skillsDir: string;
  configManager: ConfigManager;
  customEnv?: Record<string, string>;
}

export const skillToolDefinitions: ToolDefinition[] = [
  {
    name: 'skill_list',
    description:
      'List all installed skills. Skills provide step-by-step instructions, scripts, and reference files ' +
      'that extend your capabilities. Use skill_read to load a skill\'s full instructions before using it.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'skill_read',
    description:
      'Load the full instructions for a skill by name. Returns the detailed instructions and the skill\'s ' +
      'directory path so you can access its scripts, references, and assets. Follow the instructions ' +
      'carefully — you will typically execute the skill using shell commands, curl, python, etc.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The exact name of the skill to load (as shown by skill_list)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'skill_create',
    description:
      'Install a new skill from a SKILL.md content string. Creates the skill directory and SKILL.md file, ' +
      'then loads it into the registry. You can also create additional files (scripts/, references/, assets/) ' +
      'in the skill directory afterward using shell commands or using the skill_update(name="...", fileName="...", content="...") function.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill directory name (lowercase, hyphens allowed, e.g. "my-new-skill")',
        },
        content: {
          type: 'string',
          description: 'Full SKILL.md content including YAML frontmatter and markdown body',
        },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'skill_update',
    description: 'Update or create a file in a skill directory by name. Updates or create the file in the skill directory, ' +
      'then loads it into the registry.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The exact name of the skill to update (as shown by skill_list)',
        },
        fileName: {
          type: 'string',
          description: 'The exact name of the file to update',
        },
        content: {
          type: 'string',
          description: 'The content of the file to update',
        },
      },
      required: ['name', 'fileName', 'content'],
    },
  },
  {
    name: 'skill_remove',
    description: 'Remove an installed skill by name. Deletes the skill directory and unregisters it.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The exact name of the skill to remove',
        },
      },
      required: ['name'],
    },
  },
];

export function handleSkillTool(
  name: string,
  args: Record<string, unknown>,
  context: SkillToolContext,
  multiUserEnabled: boolean,
  workspaceId: string,
): string {
  switch (name) {
    case 'skill_list': {
      const skills = context.skillRegistry.list(workspaceId);
      if (skills.length === 0) {
        return JSON.stringify({ ok: true, skills: [], message: 'No skills installed.' });
      }
      return JSON.stringify({
        ok: true,
        skills: skills.map(s => ({
          name: s.name,
          description: s.description,
          ...(s.version && { version: s.version }),
          ...(s.emoji && { emoji: s.emoji }),
          ...(s.homepage && { homepage: s.homepage }),
          ...(s.requires && { requires: s.requires }),
        })),
        hint: 'Use skill_read(name="...") to load full instructions before using a skill.',
      });
    }

    case 'skill_read': {
      const skillName = args.name as string;
      if (!skillName) {
        return JSON.stringify({ ok: false, error: 'Skill name is required.' });
      }
      const skill = context.skillRegistry.get(skillName, workspaceId);
      if (!skill) {
        const available = context.skillRegistry.list(workspaceId).map(s => s.name);
        return JSON.stringify({
          ok: false,
          error: `Skill "${skillName}" not found.`,
          availableSkills: available,
        });
      }

      const dirContents = listDirRecursive(skill.dirPath!, 2);
      const requirementsCheck = skill.requires ? checkRequirements(skill.requires, context.customEnv) : undefined;

      return JSON.stringify({
        ok: true,
        name: skill.name,
        description: skill.description,
        ...(skill.version && { version: skill.version }),
        ...(skill.homepage && { homepage: skill.homepage }),
        dirPath: skill.dirPath,
        files: dirContents,
        ...(requirementsCheck && { requirements: requirementsCheck }),
        instructions: skill.instructions ?? '(No detailed instructions provided)',
      });
    }

    case 'skill_create': {
      const skillName = args.name as string;
      const content = args.content as string;

      if (!skillName || !content) {
        return JSON.stringify({ ok: false, error: 'Both "name" and "content" are required.' });
      }

      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(skillName)) {
        return JSON.stringify({
          ok: false,
          error: 'Invalid skill name. Use lowercase letters, numbers, and hyphens. Must not start/end with a hyphen.',
        });
      }

      let skillDir: string;
      if (multiUserEnabled) {
        skillDir = join(context.configManager.getWorkspacePath(workspaceId), 'skills', skillName);
      } else {
        skillDir = join(context.skillsDir!, skillName);
      }
      try {
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8');

        const manifest = loadSkill(join(skillDir, 'SKILL.md'));
        if (!manifest) {
          rmSync(skillDir, { recursive: true, force: true });
          return JSON.stringify({ ok: false, error: 'Invalid SKILL.md: missing required frontmatter (name, description).' });
        }

        if (multiUserEnabled) {
          context.skillRegistry.registerWorkspaceSkill(workspaceId, manifest);
        } else {
          context.skillRegistry.register(manifest);
        }
        logger.info('skill-tool', `Installed skill "${skillName}" at ${skillDir}`);

        return JSON.stringify({
          ok: true,
          message: `Skill "${skillName}" installed successfully.`,
          dirPath: skillDir,
          hint: 'You can now create additional files (scripts/, references/, assets/) in the skill directory using shell commands or using the skill_update(name="...", fileName="...", content="...") function.',
        });
      } catch (err) {
        return JSON.stringify({ ok: false, error: `Failed to install skill: ${(err as Error).message}` });
      }
    }

    case 'skill_update': {
      const skillName = args.name as string;
      const fileName = args.fileName as string;
      const content = args.content as string;

      const skill = context.skillRegistry.get(skillName, workspaceId);
      if (!skill) {
        return JSON.stringify({ ok: false, error: `Skill "${skillName}" not found.` });
      }

      let baseSkillDir: string;
      if (multiUserEnabled) {
        baseSkillDir = join(context.configManager.getWorkspacePath(workspaceId), 'skills', skillName);
      } else {
        baseSkillDir = join(context.skillsDir!, skillName);
      }

      // Check dirPath is inside baseSkillDir
      if (skill.dirPath && !skill.dirPath.startsWith(baseSkillDir)) {
        return JSON.stringify({ ok: false, error: `You are not allowed to update "${skillName}".` });
      }

      if (!skillName || !content || !fileName) {
        return JSON.stringify({ ok: false, error: 'Both "name" and "content" are required.' });
      }

      // Prevent file traversal
      if (fileName.includes('..')) {
        return JSON.stringify({ ok: false, error: 'File name contains invalid path components.' });
      }

      // Prevent file name to be a directory
      if (fileName.endsWith('/')) {
        return JSON.stringify({ ok: false, error: 'File name cannot end with a slash.' });
      }

      try {
        writeFileSync(join(baseSkillDir, fileName), content, 'utf-8');

        const manifest = loadSkill(join(baseSkillDir, 'SKILL.md'));
        if (!manifest) {
          rmSync(baseSkillDir, { recursive: true, force: true });
          return JSON.stringify({ ok: false, error: 'Invalid SKILL.md: missing required frontmatter (name, description).' });
        }

        if (multiUserEnabled) {
          context.skillRegistry.registerWorkspaceSkill(workspaceId, manifest);
        } else {
          context.skillRegistry.register(manifest);
        }
        logger.info('skill-tool', `Updated skill "${skillName}" at ${baseSkillDir} with file ${fileName}`);

        return JSON.stringify({
          ok: true,
          message: `Skill "${skillName}" updated successfully.`,
          dirPath: baseSkillDir,
        });
      } catch (err) {
        return JSON.stringify({ ok: false, error: `Failed to update skill: ${(err as Error).message}` });
      }
    }

    case 'skill_remove': {
      const skillName = args.name as string;
      if (!skillName) {
        return JSON.stringify({ ok: false, error: 'Skill name is required.' });
      }

      const skill = context.skillRegistry.get(skillName, workspaceId);
      if (!skill) {
        return JSON.stringify({ ok: false, error: `Skill "${skillName}" not found.` });
      }

      let baseSkillDir: string;
      if (multiUserEnabled) {
        baseSkillDir = join(context.configManager.getWorkspacePath(workspaceId), 'skills', skillName);
      } else {
        baseSkillDir = join(context.skillsDir!, skillName);
      }

      try {
        if (skill.dirPath && existsSync(skill.dirPath)) {
          if (skill.dirPath && skill.dirPath.startsWith(baseSkillDir)) {
            rmSync(skill.dirPath, { recursive: true, force: true });
            if (multiUserEnabled) {
              context.skillRegistry.removeWorkspaceSkill(workspaceId, skillName);
            } else {
              context.skillRegistry.remove(skillName);
            }
            logger.info('skill-tool', `Removed skill "${skillName}"`);
            return JSON.stringify({ ok: true, message: `Skill "${skillName}" removed.` });
          }

          throw new Error(`You are not allowed to remove "${skillName}".`);
        }
      } catch (err) {
        return JSON.stringify({ ok: false, error: `Failed to remove skill: ${(err as Error).message}` });
      }
    }

    default:
      return JSON.stringify({ ok: false, error: `Unknown skill tool: ${name}` });
  }
}

function checkRequirements(requires: SkillRequirements, customEnv?: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (requires.bins?.length) {
    const bins: Record<string, boolean> = {};
    for (const bin of requires.bins) {
      try {
        execSync(`which ${bin}`, { stdio: 'pipe' });
        bins[bin] = true;
      } catch {
        bins[bin] = false;
      }
    }
    result.bins = bins;
  }

  if (requires.env?.length) {
    const env: Record<string, boolean> = {};
    for (const varName of requires.env) {
      env[varName] = !!(process.env[varName] || customEnv?.[varName]);
    }
    result.env = env;
  }

  const allBinsOk = !requires.bins?.length || Object.values(result.bins as Record<string, boolean>).every(Boolean);
  const allEnvOk = !requires.env?.length || Object.values(result.env as Record<string, boolean>).every(Boolean);
  result.satisfied = allBinsOk && allEnvOk;
  if (!result.satisfied) {
    result.hint = 'Missing requirements can be configured in the web admin under Security > Environment Variables, or set in settings.yml under shell_sandbox.customEnv';
  }

  return result;
}

function listDirRecursive(dir: string, maxDepth: number, depth = 0): string[] {
  if (!dir || !existsSync(dir) || depth > maxDepth) return [];
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = depth === 0 ? entry.name : entry.name;
      if (entry.isDirectory()) {
        results.push(`${rel}/`);
        const sub = listDirRecursive(join(dir, entry.name), maxDepth, depth + 1);
        for (const s of sub) results.push(`  ${rel}/${s.trimStart()}`);
      } else {
        results.push(rel);
      }
    }
  } catch { /* ignore read errors */ }
  return results;
}
