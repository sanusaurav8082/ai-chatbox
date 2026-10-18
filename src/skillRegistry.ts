export interface SkillManifest {
  id: string; version: string; name: string; description: string; instructions: string; keywords: string[]; enabled?: boolean;
}
export interface RegisteredSkill extends SkillManifest { enabled: boolean; }
export interface SkillSelection { skill: RegisteredSkill; score: number; matchedKeywords: string[]; }
export const MAX_SKILLS = 100;
export const MAX_SKILL_INSTRUCTIONS = 12_000;
export const MAX_SKILL_KEYWORDS = 32;
export const MAX_SELECTED_SKILLS = 5;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSkillManifest(value: unknown): SkillManifest {
  if (!isRecord(value)) throw new Error("Skill manifest must be an object.");
  const { id, version, name, description, instructions, keywords, enabled } = value;
  if (typeof id !== "string" || id.length > 80 || !ID_PATTERN.test(id)) throw new Error("Invalid skill id.");
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) throw new Error("Skill version must be semantic versioning, e.g. 1.0.0.");
  if (typeof name !== "string" || !name.trim() || name.length > 120) throw new Error("Skill name must be non-empty and at most 120 characters.");
  if (typeof description !== "string" || !description.trim() || description.length > 500) throw new Error("Skill description must be non-empty and at most 500 characters.");
  if (typeof instructions !== "string" || !instructions.trim() || instructions.length > MAX_SKILL_INSTRUCTIONS) throw new Error("Skill instructions are empty or exceed 12000 characters.");
  if (!Array.isArray(keywords) || keywords.length > MAX_SKILL_KEYWORDS || keywords.some((k) => typeof k !== "string" || !k.trim() || k.length > 64)) throw new Error("Invalid skill keywords.");
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("Skill enabled must be a boolean.");
  return { id, version, name: name.trim(), description: description.trim(), instructions: instructions.trim(), keywords: [...new Set((keywords as string[]).map(k => k.trim().toLowerCase()))], ...(enabled === undefined ? {} : { enabled }) };
}
export class SkillRegistry {
  private readonly skills = new Map<string, RegisteredSkill>();
  register(value: unknown): RegisteredSkill {
    const manifest = parseSkillManifest(value);
    if (!this.skills.has(manifest.id) && this.skills.size >= MAX_SKILLS) throw new Error("Skill registry limit reached.");
    const skill: RegisteredSkill = { ...manifest, enabled: manifest.enabled ?? true };
    this.skills.set(skill.id, skill);
    return cloneSkill(skill);
  }
  list(): RegisteredSkill[] { return [...this.skills.values()].sort((a,b) => a.id.localeCompare(b.id)).map(cloneSkill); }
  setEnabled(id: string, enabled: boolean): boolean {
    const skill = this.skills.get(id); if (!skill) return false; skill.enabled = enabled; return true;
  }
  select(task: string, limit = MAX_SELECTED_SKILLS): SkillSelection[] {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_SELECTED_SKILLS) throw new Error("Selection limit must be an integer from 0 to 5.");
    const terms = new Set(tokenize(task)); if (!terms.size || !limit) return [];
    const matches: SkillSelection[] = [];
    for (const skill of this.skills.values()) {
      if (!skill.enabled) continue;
      const matchedKeywords = skill.keywords.filter(keyword => tokenize(keyword).some(term => terms.has(term)));
      if (matchedKeywords.length) matches.push({ skill: cloneSkill(skill), score: matchedKeywords.length, matchedKeywords });
    }
    return matches.sort((a,b) => b.score-a.score || a.skill.id.localeCompare(b.skill.id)).slice(0, limit);
  }
}
function tokenize(value: string): string[] { return value.toLowerCase().match(/[a-z0-9]+/g) ?? []; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function cloneSkill<T extends RegisteredSkill | SkillManifest>(skill: T): T { return { ...skill, keywords: [...skill.keywords] }; }
