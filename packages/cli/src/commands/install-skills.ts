import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Exec } from "../exec";
import { type ListEntry, parseList } from "../lists";
import type { Reporter } from "../report";
import { loadState, saveState } from "../state";

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
      `the skills CLI needs Node ${SKILLS_NODE_FLOOR} or newer, this shell runs ${nodeVersion} — run "nvm use" in the company repository`,
    );
    return 1;
  }

  const state = loadState(deps.managedFile);
  const next: Record<string, string[]> = {};
  for (const entry of entries) {
    if (isSha(entry.ref)) {
      reporter.item(entry.raw, "failed", "the skills CLI checks out a tag or a branch, not a commit hash — pin a tag");
      continue;
    }
    const before = state.skills[entry.raw];
    if (sameAgents(before, agents)) {
      next[entry.raw] = agents;
      reporter.item(entry.raw, "ok", "already installed");
      continue;
    }
    const args = ["add", toSkillsSource(entry), "-g", "-y", ...agents.flatMap((a) => ["-a", a])];
    const result = await exec(deps.skillsBin, args);
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
    const wasKnown = Object.keys(state.skills).some((raw) => raw.split("@")[0] === entry.repo);
    reporter.item(entry.raw, wasKnown ? "updated" : "installed", `agents: ${agents.join(", ")}`);
  }
  // A state entry that no list names any more. A pin bump (same repo, new ref) and a failed
  // entry are not stale: the first is reported as updated, the second as failed.
  const repoOf = (raw: string): string => parseList(raw).entries[0]?.repo ?? raw;
  for (const raw of Object.keys(state.skills).filter((r) => !(r in next))) {
    if (entries.some((e) => e.raw === raw || e.repo === repoOf(raw))) continue;
    reporter.item(raw, "skipped", "no longer listed — remove by hand with: skills remove -g <skill-name>");
  }
  state.skills = next;
  saveState(deps.managedFile, state);
  return reporter.failed() ? 1 : 0;
}
