import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Exec, ExecResult } from "../exec";
import { HARNESSES } from "../harness";
import { type ListEntry, parseList, replaceListLine, VERSION_TAG } from "../lists";
import type { Reporter } from "../report";
import { loadSkillLock, normalizeSource, skillsOfSource, staleSkills } from "../skill-lock";
import { clearManagedSkills, loadState, saveState } from "../state";

// The floor check below reads process.version, and the invocation of the skills CLI runs
// under process.execPath. Both name the same Node binary that runs wagglebot.
export const SKILLS_NODE_FLOOR = "22.20.0";

// The skills CLI is a dependency of this package, so a normal install always has it. A missing
// module means a broken or partial install. The installer then skips with a remedy (spec: warn
// and continue). It never aborts the whole update before git pull.
export function resolveSkillsBin(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("skills/package.json");
    const pkg: { bin: string | Record<string, string> } = require("skills/package.json");
    const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.skills ?? Object.values(pkg.bin)[0] ?? "");
    return join(dirname(pkgPath), rel);
  } catch {
    return undefined;
  }
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

// Seven to forty hex characters with at least one letter is a commit hash, short or full. An
// all-digit ref such as 20260909 is a tag. The skills CLI checks out a tag or a branch only.
const isSha = (ref: string | undefined): boolean =>
  ref !== undefined && /^[0-9a-f]{7,40}$/i.test(ref) && /[a-f]/i.test(ref);
const sameAgents = (a: string[] | undefined, b: string[]): boolean => JSON.stringify(a ?? null) === JSON.stringify(b);

// Skills 1.5.23 can report removal or scan failures with exit code zero.
const removalSucceeded = (result: ExecResult): boolean =>
  result.code === 0 &&
  !/Could not (?:remove skill from|scan directory) |Failed to remove \d+ skill\(s\)/.test(
    stripVTControlCharacters(`${result.stdout}\n${result.stderr}`),
  );

// Highest tag by numeric comparison of "v1.2.3"-like names. Non-numeric tags sort last.
const highestTag = (lsRemote: string): string | undefined =>
  lsRemote
    .split("\n")
    .map((line) => line.split("refs/tags/")[1])
    .filter((t): t is string => t !== undefined && t !== "" && VERSION_TAG.test(t))
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
  skillsBin: string | undefined;
  skillsAgents: string[];
  managedFile: string;
  skillLockFile: string;
  organization?: string[];
  nodeVersion?: string;
  update?: boolean;
  overwriteLocal?: boolean;
  phase?: "remove" | "install";
  staleRemovalAgents?: string[];
  writeList?: (path: string, text: string) => void;
}): Promise<number> {
  const { reporter, exec } = deps;
  reporter.section("Skills");
  const agents = [...new Set(deps.skillsAgents)].sort();
  const allowed = HARNESSES.flatMap((harness) => harness.skillsAgents);
  if ([...agents, ...(deps.staleRemovalAgents ?? [])].some((agent) => !allowed.includes(agent))) {
    reporter.item("skills", "failed", "The selected skills adapter is not supported");
    return 1;
  }
  const parsed = deps.lists.map((l) => ({ ...l, ...parseList(l.text, { organization: deps.organization }) }));
  for (const l of parsed) for (const w of l.warnings) reporter.warn(`${l.path}: ${w}`);

  if (deps.update === true) {
    for (const l of parsed) {
      let text = l.text;
      const pinned = l.entries.filter((e) => e.ref !== undefined);
      // The remotes are independent, so every ls-remote runs at once. The rewrites stay in list
      // order below.
      const remotes = await Promise.all(
        pinned.map((entry) => {
          if (!VERSION_TAG.test(entry.ref ?? "")) return Promise.resolve(undefined);
          const url = entry.isUrl === true ? entry.repo : `https://github.com/${entry.repo}.git`;
          return exec("git", ["ls-remote", "--tags", "--refs", url]);
        }),
      );
      for (const [index, entry] of pinned.entries()) {
        if (!VERSION_TAG.test(entry.ref ?? "")) {
          reporter.item(entry.repo, "skipped", `pin "${entry.ref}" is a branch or a commit, not a version tag — kept`);
          continue;
        }
        const remote = remotes[index];
        const tag = remote !== undefined && remote.code === 0 ? highestTag(remote.stdout) : undefined;
        if (tag === undefined) {
          reporter.item(entry.repo, "skipped", "no version tag on the remote — pin kept");
          continue;
        }
        if (tag === entry.ref) {
          reporter.item(entry.repo, "ok", `already at ${tag}`);
          continue;
        }
        const next = entry.isUrl === true ? `${entry.repo} ${tag}` : `${entry.repo}@${tag}`;
        text = replaceListLine(text, entry.raw, next);
        reporter.item(entry.repo, "updated", `pin ${entry.ref} -> ${tag}`);
      }
      if (text !== l.text) deps.writeList?.(l.path, text);
    }
    return reporter.failed() ? 1 : 0;
  }

  const entries = parsed.flatMap((l) => l.entries);
  const state = loadState(deps.managedFile);
  if (entries.length === 0 && Object.keys(state.skills).length === 0 && !deps.overwriteLocal) {
    reporter.item("skills", "skipped", "no entries in any skills.list");
    return 0;
  }
  if (agents.length === 0) {
    reporter.item("skills", "skipped", "no selected harness has a skills CLI adapter");
    return 0;
  }
  if (deps.skillsBin === undefined) {
    reporter.item(
      "skills",
      "skipped",
      'the skills CLI is not installed — run "yarn install" in the company repository, then run wagglebot update again',
    );
    return 0;
  }
  const skillsBin = deps.skillsBin;
  const nodeVersion = deps.nodeVersion ?? process.version;
  if (!nodeSatisfies(nodeVersion, SKILLS_NODE_FLOOR)) {
    reporter.item(
      "skills",
      "failed",
      `the skills CLI needs Node ${SKILLS_NODE_FLOOR} or newer, this shell runs ${nodeVersion} — start wagglebot with a newer Node, for example "nvm use" in the company repository`,
    );
    return 1;
  }

  const verifiedRemoval = async (names: string[] | undefined, selected: string[]): Promise<boolean> => {
    const listing = await exec(process.execPath, [
      skillsBin,
      "ls",
      "--global",
      "--json",
      ...selected.flatMap((a) => ["--agent", a]),
    ]);
    if (!removalSucceeded(listing)) return false;
    try {
      const remaining: unknown = JSON.parse(listing.stdout);
      if (!Array.isArray(remaining)) return false;
      return remaining.every((skill) => {
        if (
          typeof skill !== "object" ||
          skill === null ||
          typeof skill.name !== "string" ||
          !Array.isArray(skill.agents)
        )
          return false;
        if (names !== undefined && !names.includes(skill.name)) return true;
        return !skill.agents.some((label: unknown) => {
          if (typeof label !== "string") return true;
          const agent = label === "Devin for Terminal" ? "devin" : label.toLowerCase().replaceAll(" ", "-");
          return selected.includes(agent);
        });
      });
    } catch {
      return false;
    }
  };
  if (deps.overwriteLocal && deps.phase !== "install") {
    const clear = async (selected: string[]): Promise<boolean> => {
      try {
        const result = await exec(process.execPath, [
          skillsBin,
          "remove",
          "--skill",
          "*",
          "--global",
          "--yes",
          ...selected.flatMap((agent) => ["--agent", agent]),
        ]);
        if (removalSucceeded(result) && (await verifiedRemoval(undefined, selected))) {
          clearManagedSkills(state, selected);
          saveState(deps.managedFile, state);
          for (const agent of selected) reporter.item(agent, "updated", "Removed all global skills for this adapter");
          return true;
        }
      } catch {}
      return false;
    };
    if (!(await clear(agents))) {
      for (const agent of agents) {
        if (agents.length === 1 || !(await clear([agent])))
          reporter.item(agent, "failed", "Cannot remove global skills for this adapter");
      }
    }
  }
  const next: Record<string, string[]> = { ...state.skills };
  const agentFlags = agents.flatMap((a) => ["-a", a]);
  // The repo a raw list line names. Handles both "owner/repo@ref" and "<url> ref" forms.
  const repoOf = (raw: string): string => parseList(raw).entries[0]?.repo ?? raw;

  const removeSkill = async (name: string, reason: string, selected = agents): Promise<boolean> => {
    try {
      const result = await exec(process.execPath, [
        skillsBin,
        "remove",
        name,
        "-g",
        "-y",
        ...selected.flatMap((agent) => ["-a", agent]),
      ]);
      const removed = removalSucceeded(result) && (await verifiedRemoval([name], selected));
      if (removed) reporter.item(name, "updated", `removed — ${reason}`);
      else reporter.item(name, "failed", `skills remove failed — ${reason}`);
      return removed;
    } catch {
      reporter.item(name, "failed", `skills remove failed — ${reason}`);
      return false;
    }
  };

  for (const entry of deps.phase === "remove" ? [] : entries) {
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
    const result = await exec(process.execPath, [skillsBin, ...args]);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0 || output.includes("Installation failed")) {
      const reason = output
        .split("\n")
        .map((line) => line.replace(/\[[0-9;?]*[A-Za-z]/g, "").trim())
        .find((line) => /failed|error/i.test(line));
      reporter.item(entry.raw, "failed", reason ?? "skills add failed");
      continue;
    }
    for (const raw of Object.keys(next).filter((raw) => repoOf(raw) === entry.repo)) {
      const kept = (next[raw] ?? []).filter((agent) => !agents.includes(agent));
      if (kept.length === 0) delete next[raw];
      else next[raw] = kept;
    }
    next[entry.raw] = [...new Set([...(next[entry.raw] ?? []), ...agents])].sort();

    const lock = loadSkillLock(deps.skillLockFile);
    const mine = skillsOfSource(lock, entry.repo);
    const added = mine.filter((name) => !known.includes(name));
    const wasKnown = Object.keys(state.skills).some((raw) => repoOf(raw) === entry.repo);
    const detail = `agents: ${agents.join(", ")}${added.length === 0 ? "" : `; new: ${added.join(", ")}`}`;
    const selectedBefore = state.skills[entry.raw]?.filter((agent) => agents.includes(agent)).sort();
    const moved = added.length > 0 || !sameAgents(selectedBefore, agents);
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
    for (const name of stale)
      await removeSkill(name, `deleted upstream in ${entry.repo}`, deps.staleRemovalAgents ?? agents);
  }

  // A partial upgrade can leave several pins for one repository. Remove their selected adapters together.
  const staleRepos = new Map<string, string[]>();
  for (const raw of deps.phase === "install" ? [] : Object.keys(state.skills)) {
    const repo = normalizeSource(repoOf(raw));
    if (entries.some((entry) => normalizeSource(entry.repo) === repo)) continue;
    staleRepos.set(repo, [...(staleRepos.get(repo) ?? []), raw]);
  }
  for (const [repo, records] of staleRepos) {
    const selected = [...new Set(records.flatMap((raw) => state.skills[raw] ?? []))]
      .filter((agent) => agents.includes(agent))
      .sort();
    if (selected.length === 0 || deps.overwriteLocal) continue;
    const names = skillsOfSource(loadSkillLock(deps.skillLockFile), repo);
    if (names.length === 0) {
      if (!(await verifiedRemoval(undefined, selected))) {
        reporter.item(repo, "failed", "Cannot verify removal without source lock entries. Ownership is retained.");
        continue;
      }
      reporter.item(repo, "ok", "no longer listed — nothing left to remove");
    }
    let removed = true;
    for (const name of names) {
      if (!(await removeSkill(name, `${repo} is no longer listed`, selected))) removed = false;
    }
    if (removed) {
      for (const raw of records) {
        const kept = (next[raw] ?? []).filter((agent) => !selected.includes(agent));
        if (kept.length === 0) delete next[raw];
        else next[raw] = kept;
      }
    }
  }
  state.skills = next;
  saveState(deps.managedFile, state);
  return reporter.failed() ? 1 : 0;
}
