import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillLock, normalizeSource, resolveSkillLockFile, skillsOfSource, staleSkills } from "./skill-lock";

const write = (content: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), "wgl-lock-")), ".skill-lock.json");
  writeFileSync(file, content);
  return file;
};

test("the lock file follows XDG_STATE_HOME, and falls back to ~/.agents", () => {
  expect(resolveSkillLockFile("/home/x", {})).toBe("/home/x/.agents/.skill-lock.json");
  expect(resolveSkillLockFile("/home/x", { XDG_STATE_HOME: "" })).toBe("/home/x/.agents/.skill-lock.json");
  expect(resolveSkillLockFile("/home/x", { XDG_STATE_HOME: "/s" })).toBe("/s/skills/.skill-lock.json");
});

test("a missing or malformed lock file reads as empty", () => {
  expect(loadSkillLock("/nowhere/.skill-lock.json")).toEqual({});
  expect(loadSkillLock(write("{"))).toEqual({});
  expect(loadSkillLock(write("[]"))).toEqual({});
  expect(loadSkillLock(write('{"version":3}'))).toEqual({});
});

test("every form of one source normalizes to the same key", () => {
  const forms = [
    "obra/superpowers",
    "https://github.com/obra/superpowers.git",
    "https://github.com/Obra/Superpowers",
    "git@github.com:obra/superpowers.git",
    "ssh://git@github.com/obra/superpowers.git",
  ];
  expect(new Set(forms.map(normalizeSource)).size).toBe(1);
  expect(normalizeSource("https://git.internal/team/skills.git")).toBe("https://git.internal/team/skills");
});

test("attributes each installed skill to its source and marks the unstamped ones stale", () => {
  const now = Date.now();
  const file = write(
    JSON.stringify({
      version: 3,
      skills: {
        alpha: { source: "a/b", sourceUrl: "https://github.com/a/b.git", updatedAt: new Date(now).toISOString() },
        beta: { source: "a/b", sourceUrl: "https://github.com/a/b.git", updatedAt: new Date(now - 9e5).toISOString() },
        gamma: { sourceType: "git", sourceUrl: "https://git.internal/team/skills.git", updatedAt: "nonsense" },
        delta: { source: "c/d" },
      },
    }),
  );
  const lock = loadSkillLock(file);
  expect(skillsOfSource(lock, "https://github.com/a/b.git")).toEqual(["alpha", "beta"]);
  expect(skillsOfSource(lock, "https://git.internal/team/skills.git")).toEqual(["gamma"]);
  expect(skillsOfSource(lock, "e/f")).toEqual([]);
  expect(staleSkills(lock, "a/b", now)).toEqual(["beta"]);
  // An unreadable or absent updatedAt is never taken as evidence of a deletion.
  expect(staleSkills(lock, "https://git.internal/team/skills.git", now)).toEqual([]);
  expect(staleSkills(lock, "c/d", now)).toEqual([]);
});
