import type { SkillManifest } from '../core/types.js';
import { loadAllSkills } from './loader.js';
import { logger } from '../core/logger.js';

const SCOPE = 'skill-registry';

export class SkillRegistry {
  private skills: Map<string, SkillManifest> = new Map();
  private workspaceSkills: Map<string, Map<string, SkillManifest>> = new Map();

  register(skill: SkillManifest): void {
    if (this.skills.has(skill.name)) {
      logger.warn(SCOPE, `Overwriting previously registered skill "${skill.name}"`);
    }
    this.skills.set(skill.name, skill);
    logger.debug(SCOPE, `Registered skill "${skill.name}"`);
  }

  get(name: string, workspaceId?: string): SkillManifest | undefined {
    if (workspaceId) {
      const wsSkills = this.workspaceSkills.get(workspaceId);
      if (wsSkills?.has(name)) return wsSkills.get(name);
    }
    return this.skills.get(name);
  }

  list(workspaceId?: string): SkillManifest[] {
    const global = Array.from(this.skills.values());
    if (!workspaceId) return global;

    const wsSkills = this.workspaceSkills.get(workspaceId);
    if (!wsSkills || wsSkills.size === 0) return global;

    const merged = new Map<string, SkillManifest>();
    for (const s of global) merged.set(s.name, s);
    for (const [name, s] of wsSkills) merged.set(name, s);
    return Array.from(merged.values());
  }

  remove(name: string): boolean {
    return this.skills.delete(name);
  }

  loadFromDirectory(dir: string): void {
    this.skills.clear();
    const manifests = loadAllSkills(dir);
    for (const manifest of manifests) {
      this.register(manifest);
    }
    logger.info(SCOPE, `Loaded ${manifests.length} skill(s) from directory`);
  }

  loadWorkspaceSkills(workspaceId: string, dir: string): void {
    const wsMap = new Map<string, SkillManifest>();
    try {
      const manifests = loadAllSkills(dir);
      for (const manifest of manifests) {
        wsMap.set(manifest.name, manifest);
      }
      logger.info(SCOPE, `Loaded ${manifests.length} workspace skill(s) for ${workspaceId}`);
    } catch {
      logger.debug(SCOPE, `No workspace skills directory for ${workspaceId}`);
    }
    this.workspaceSkills.set(workspaceId, wsMap);
  }

  registerWorkspaceSkill(workspaceId: string, skill: SkillManifest): void {
    let wsSkills = this.workspaceSkills.get(workspaceId);
    if (!wsSkills) {
      wsSkills = new Map();
      this.workspaceSkills.set(workspaceId, wsSkills);
    }
    wsSkills.set(skill.name, skill);
    logger.debug(SCOPE, `Registered workspace skill "${skill.name}" for ${workspaceId}`);
  }

  removeWorkspaceSkill(workspaceId: string, name: string): boolean {
    const wsSkills = this.workspaceSkills.get(workspaceId);
    if (!wsSkills) return false;
    return wsSkills.delete(name);
  }
}
