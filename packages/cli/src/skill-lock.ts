import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The skills CLI records every globally installed skill in this lock file: the skill name, the
// source it came from, and the time the CLI last wrote it. The lock file is the only
// machine-readable link between an installed skill and the list entry that installed it.
// `skills ls --json` reports the name, the path and the agents, but never the source.
export type SkillLockEntry = { source?: string; sourceUrl?: string; ref?: string; updatedAt?: string };
export type SkillLock = Record<string, SkillLockEntry>;

export function resolveSkillLockFile(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  return xdg === undefined || xdg === ""
    ? join(home, ".agents", ".skill-lock.json")
    : join(xdg, "skills", ".skill-lock.json");
}

const asEntry = (value: unknown): SkillLockEntry | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof record[key] === "string" ? record[key] : undefined);
  return { source: str("source"), sourceUrl: str("sourceUrl"), ref: str("ref"), updatedAt: str("updatedAt") };
};

// A missing or malformed lock file means "nothing is known about any source". Every caller then
// installs and removes nothing, which is the safe direction.
export function loadSkillLock(file: string): SkillLock {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null) return {};
  const skills = (raw as Record<string, unknown>).skills;
  if (typeof skills !== "object" || skills === null) return {};
  const lock: SkillLock = {};
  for (const [name, value] of Object.entries(skills as Record<string, unknown>)) {
    const entry = asEntry(value);
    if (entry !== undefined) lock[name] = entry;
  }
  return lock;
}

// "owner/repo", "https://github.com/owner/repo.git" and "git@github.com:owner/repo" all name the
// same source. The lock file writes one form, a skills.list line writes another. Reduce both to
// one comparable key.
export function normalizeSource(source: string): string {
  const trimmed = source
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const github = /^(?:https?:\/\/|ssh:\/\/(?:git@)?|git@)github\.com[/:](.+)$/i.exec(trimmed);
  return (github?.[1] ?? trimmed).toLowerCase();
}

export function skillsOfSource(lock: SkillLock, source: string): string[] {
  const key = normalizeSource(source);
  return Object.entries(lock)
    .filter(([, entry]) => [entry.source, entry.sourceUrl].some((s) => s !== undefined && normalizeSource(s) === key))
    .map(([name]) => name)
    .sort();
}

// `skills add` rewrites updatedAt for every skill it installs, even for a skill whose content did
// not change. A skill that the lock still attributes to the source, but that the add did not
// stamp, is no longer in the source repository. An entry without a readable updatedAt is never
// stale, because the removal must not act on a value it cannot read.
export function staleSkills(lock: SkillLock, source: string, since: number): string[] {
  return skillsOfSource(lock, source).filter((name) => {
    const at = Date.parse(lock[name]?.updatedAt ?? "");
    return !Number.isNaN(at) && at < since;
  });
}
