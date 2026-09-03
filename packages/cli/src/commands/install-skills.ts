import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Exec } from "../exec";
import { type ListEntry, parseList } from "../lists";
import type { Reporter } from "../report";
import { loadSkillLock, skillsOfSource, staleSkills } from "../skill-lock";
import { loadState, saveState } from "../state";

// The floor check below reads process.version, and the invocation of the skills CLI runs
// under process.execPath. Both name the same Node binary that runs wagglebot.
export const SKILLS_NODE_FLOOR = "22.20.0";

export function resolveSkillsBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("skills/package.json");
  const pkg: { bin: string | Record<string, string> } = require("skills/package.json");
  const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.skills ?? Object.values(pkg.bin)[0] ?? "");
  return join(dirname(pkgPath), rel);
}

// Our lists write a pin as "@<ref>". The skills CLI reads "@" as a skill-name filter and
// takes the ref after "#" instead. Translate at the boundary so both lists share one format.
export const toSkillsSource = (entry: ListEntry): string =>
  entry.ref === undefined ? entry.repo : `${entry.repo}#${entry.ref}`;

const parts = (v: string): number[] =>
  v
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
export function nodeSatisfies(version: string, floor: string): boolean {
  const a = parts(version);
  const b = parts(floor);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const isSha = (ref: string | undefined): boolean => ref !== undefined && /^[0-9a-f]{40}$/i.test(ref);
const sameAgents = (a: string[] | undefined, b: string[]): boolean => JSON.stringify(a ?? null) === JSON.stringify(b);

// Highest tag by numeric comparison of "v1.2.3"-like names. Non-numeric tags sort last.
const highestTag = (lsRemote: string): string | undefined =>
  lsRemote
    .split("\n")
    .map((line) => line.split("refs/tags/")[1])
    .filter((t): t is string => t !== undefined && t !== "" && /^v?\d+(\.\d+)*$/.test(t))
    .sort((x, y) => {
      const a = parts(x);
      const b = parts(y);
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
      }
      return 0;
    })[0];

export async function runInstallSkills(deps: {
  lists: { path: string; text: string }[];
  exec: Exec;
  reporter: Reporter;
  skillsBin: string;
  skillsAgents: string[];
  managedFile: string;
  skillLockFile: string;
  nodeVersion?: string;
  update?: boolean;
  writeList?: (path: string, text: string) => void;
}): Promise<number> {
  const { reporter, exec } = deps;
  reporter.section("Skills");
  const agents = [...deps.skillsAgents].sort();
  const parsed = deps.lists.map((l) => ({ ...l, ...parseList(l.text) }));
  for (const l of parsed) for (const w of l.warnings) reporter.item(`${l.path}: ${w}`, "skipped", "warning only");

  if (deps.update === true) {
    for (const l of parsed) {
      let text = l.text;
      for (const entry of l.entries.filter((e) => e.ref !== undefined)) {
        const url = entry.isUrl === true ? entry.repo : `https://github.com/${entry.repo}.git`;
        const remote = await exec("git", ["ls-remote", "--tags", "--refs", url]);
        const tag = remote.code === 0 ? highestTag(remote.stdout) : undefined;
        if (tag === undefined) {
          reporter.item(entry.repo, "skipped", "no version tag on the remote — pin kept");
          continue;
        }
        if (tag === entry.ref) {
          reporter.item(entry.repo, "ok", `already at ${tag}`);
          continue;
        }
        const next = entry.isUrl === true ? `${entry.repo} ${tag}` : `${entry.repo}@${tag}`;
        text = text.replace(entry.raw, next);
        reporter.item(entry.repo, "updated", `pin ${entry.ref} -> ${tag}`);
      }
      if (text !== l.text) deps.writeList?.(l.path, text);
    }
    return reporter.failed() ? 1 : 0;
  }

  const entries = parsed.flatMap((l) => l.entries);
  if (entries.length === 0) {
    reporter.item("skills", "skipped", "no entries in any skills.list");
    return 0;
  }
  if (agents.length === 0) {
    reporter.item("skills", "skipped", "no selected harness has a skills CLI adapter");
    return 0;
  }
  const nodeVersion = deps.nodeVersion ?? process.version;
  if (!nodeSatisfies(nodeVersion, SKILLS_NODE_FLOOR)) {
    reporter.item(
      "skills",
      "failed",
      `the skills CLI needs Node ${SKILLS_NODE_FLOOR} or newer, this shell runs ${nodeVersion} — start wagglebot with a newer Node, for example "nvm use" in the company repository`,
    );
    return 1;
  }

  const state = loadState(deps.managedFile);
  const next: Record<string, string[]> = {};
  const agentFlags = agents.flatMap((a) => ["-a", a]);
  // The repo a raw list line names. Handles both "owner/repo@ref" and "<url> ref" forms.
  const repoOf = (raw: string): string => parseList(raw).entries[0]?.repo ?? raw;

  const removeSkill = async (name: string, reason: string): Promise<void> => {
    const result = await exec(process.execPath, [deps.skillsBin, "remove", name, "-g", "-y", ...agentFlags]);
    if (result.code === 0) reporter.item(name, "updated", `removed — ${reason}`);
    else reporter.item(name, "failed", `skills remove failed — ${reason}`);
  };

  for (const entry of entries) {
    if (isSha(entry.ref)) {
      reporter.item(entry.raw, "failed", "the skills CLI checks out a tag or a branch, not a commit hash — pin a tag");
      continue;
    }
    // The add runs on every pass, not only when the pin or the agent set moved: it is the only
    // way a skill that is new in the source repository reaches this machine. The add is
    // idempotent, and it stamps every skill it writes in the lock file.
    const known = skillsOfSource(loadSkillLock(deps.skillLockFile), entry.repo);
    const startedAt = Date.now();
    const args = ["add", toSkillsSource(entry), "-g", "-y", ...agentFlags];
    const result = await exec(process.execPath, [deps.skillsBin, ...args]);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0 || output.includes("Installation failed")) {
      const reason = output
        .split("\n")
        .map((line) => line.replace(/\[[0-9;?]*[A-Za-z]/g, "").trim())
        .find((line) => /failed|error/i.test(line));
      reporter.item(entry.raw, "failed", reason ?? "skills add failed");
      continue;
    }
    next[entry.raw] = agents;

    const lock = loadSkillLock(deps.skillLockFile);
    const mine = skillsOfSource(lock, entry.repo);
    const added = mine.filter((name) => !known.includes(name));
    const wasKnown = Object.keys(state.skills).some((raw) => repoOf(raw) === entry.repo);
    const detail = `agents: ${agents.join(", ")}${added.length === 0 ? "" : `; new: ${added.join(", ")}`}`;
    const moved = added.length > 0 || !sameAgents(state.skills[entry.raw], agents);
    if (!wasKnown) reporter.item(entry.raw, "installed", detail);
    else if (moved) reporter.item(entry.raw, "updated", detail);
    else reporter.item(entry.raw, "ok", "already installed");

    // A skill the add did not stamp is deleted in the source repository. One exception stays
    // installed: when no skill of the source was stamped, the add itself wrote nothing, so the
    // stale mark is not evidence of a deletion.
    const stale = staleSkills(lock, entry.repo, startedAt);
    if (stale.length > 0 && stale.length === mine.length) {
      reporter.item(entry.raw, "skipped", `${stale.join(", ")} look stale but the add wrote no skill — kept`);
      continue;
    }
    for (const name of stale) await removeSkill(name, `deleted upstream in ${entry.repo}`);
  }

  // A state entry that no list names any more. A pin bump (same repo, new ref) and a failed entry
  // are not stale: the first is reported as updated, the second as failed.
  for (const raw of Object.keys(state.skills).filter((r) => !(r in next))) {
    if (entries.some((e) => e.raw === raw || e.repo === repoOf(raw))) continue;
    const repo = repoOf(raw);
    const names = skillsOfSource(loadSkillLock(deps.skillLockFile), repo);
    if (names.length === 0) {
      reporter.item(raw, "ok", "no longer listed — nothing left to remove");
      continue;
    }
    for (const name of names) await removeSkill(name, `${repo} is no longer listed`);
  }
  state.skills = next;
  saveState(deps.managedFile, state);
  return reporter.failed() ? 1 : 0;
}
