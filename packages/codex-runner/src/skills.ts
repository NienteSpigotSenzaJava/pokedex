import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JsonRecord } from './types.js';
import { asArray, asRecord, stringFrom, stripUndefined } from './utils.js';

export type SkillReference = { name: string; path: string };
export type ListedSkill = SkillReference & {
  description?: string;
  enabled?: boolean;
  source?: string;
  cwd?: string;
};

export function defaultSkillRoots(): string[] {
  return [join(homedir(), '.agents', 'skills'), join(homedir(), '.codex', 'skills')];
}

export function normalizeSkills(result: unknown, fallbackCwd: string): ListedSkill[] {
  const records = asArray(asRecord(result).data);
  return records.flatMap((record) => {
    const cwd = stringFrom(asRecord(record).cwd) ?? fallbackCwd;
    return asArray(asRecord(record).skills)
      .map((skill) => listedSkillFrom(skill, cwd))
      .filter((skill): skill is ListedSkill => Boolean(skill?.name));
  });
}

export function resolveSkillName(name: string, skills: ListedSkill[]): SkillReference | null {
  const exact = skills.find((skill) => skill.name === name && skill.enabled !== false);
  const fallback = skills.find(
    (skill) => skill.name.toLowerCase() === name.toLowerCase() && skill.enabled !== false
  );
  const skill = exact ?? fallback;
  return skill ? { name: skill.name, path: skill.path } : null;
}

export function linkedSkillsFromPrompt(prompt: string): SkillReference[] {
  const links = /\[\$([a-z0-9][\w:-]*)\]\(([^)\s]+SKILL\.md)\)/gi;
  return [...prompt.matchAll(links)].map((match) => ({ name: match[1]!, path: match[2]! }));
}

export function skillMarkersFromPrompt(prompt: string): string[] {
  const linked = new Set(linkedSkillsFromPrompt(prompt).map((skill) => skill.name));
  const markers = /(^|[^\w])\$([a-z0-9][\w:-]*)/gi;
  return [...prompt.matchAll(markers)]
    .map((match) => match[2]!)
    .filter((name) => !linked.has(name));
}

export function uniqueSkills(skills: SkillReference[]): SkillReference[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = `${skill.name}\n${skill.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listedSkillFrom(value: unknown, cwd: string): ListedSkill | null {
  const raw = asRecord(value);
  const source = asRecord(raw.source);
  const definition = asRecord(raw.definition);
  const path =
    stringFrom(raw.path) ??
    stringFrom(raw.skillPath) ??
    stringFrom(raw.file) ??
    stringFrom(raw.skillFile) ??
    stringFrom(source.path) ??
    stringFrom(definition.path);
  const name = stringFrom(raw.name);
  if (!name || !path) return null;
  return stripUndefined({
    name,
    path,
    description: stringFrom(raw.description),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    source: stringFrom(source.type),
    cwd,
  } satisfies JsonRecord) as ListedSkill;
}
