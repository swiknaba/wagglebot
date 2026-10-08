import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSkillsBin, runInstallSkills } from "../src/commands/install-skills";
import { runSyncHarnesses } from "../src/commands/sync-harnesses";
import { realExec } from "../src/exec";
import { HARNESSES } from "../src/harness";
import { createReporter } from "../src/report";
import { commitAll, git, initGit, isolatedEnv, repoRoot } from "./helper";

const skillsDir = join(repoRoot, "skills");
const REQUIRED = [
  "writing-a-custom-agent",
  "adding-an-mcp-server",
  "onboarding-a-repository",
  "architecture-style-guide",
  "writing-clear-text",
];

test("installs the architecture skill from the pinned source and syncs its pointer to every harness", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "wagglebot-first-party-"));
  try {
    const home = join(scratch, "home");
    const source = join(scratch, "source");
    const env = isolatedEnv(home);
    cpSync(skillsDir, join(source, "skills"), { recursive: true });
    initGit(source, env);
    commitAll(source, env);
    git(source, env, "tag", "v1.0.0");
    const sourceUrl = "ssh://offline.invalid/first-party/wagglebot.git";
    git(source, env, "config", "--global", `url.${pathToFileURL(source).href}.insteadOf`, sourceUrl);
    const messages: string[] = [];
    const reporter = createReporter((message) => messages.push(message), false);
    const skillsBin = resolveSkillsBin();
    expect(skillsBin).toBeDefined();
    const installCode = await runInstallSkills({
      lists: [{ path: "company/skills.list", text: `${sourceUrl} v1.0.0\n` }],
      exec: (command, args) => realExec(command, args, { cwd: source, env }),
      reporter,
      skillsBin,
      skillsAgents: HARNESSES.flatMap((harness) => harness.skillsAgents),
      managedFile: join(home, ".wagglebot/managed.json"),
      skillLockFile: join(home, ".agents/.skill-lock.json"),
    });
    expect(installCode, messages.join("\n")).toBe(0);
    const lock = JSON.parse(readFileSync(join(home, ".agents/.skill-lock.json"), "utf8"));
    expect(Object.keys(lock.skills).sort()).toEqual([...REQUIRED].sort());
    const original = readFileSync(join(skillsDir, "architecture-style-guide/SKILL.md"), "utf8");
    const evaluations = readFileSync(join(skillsDir, "writing-clear-text/evaluations.md"), "utf8");
    for (const directory of [
      ".claude/skills",
      ".junie/skills",
      ".agents/skills",
      ".config/devin/skills",
      ".codeium/windsurf/skills",
      ".kiro/skills",
    ]) {
      expect(readFileSync(join(home, directory, "architecture-style-guide/SKILL.md"), "utf8")).toBe(original);
      expect(readFileSync(join(home, directory, "writing-clear-text/evaluations.md"), "utf8")).toBe(evaluations);
    }
    expect(runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [], reporter })).toBe(0);
    for (const target of HARNESSES.flatMap((harness) => harness.templateTargets)) {
      expect(readFileSync(join(home, target), "utf8")).toContain("architecture-style-guide");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

test("every first-party skill has a SKILL.md whose front matter name equals its directory", () => {
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  expect(dirs).toEqual([...REQUIRED].sort());
  for (const dir of dirs) {
    const text = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(front, `${dir}/SKILL.md has no front matter`).not.toBeNull();
    expect(front?.[1]).toContain(`name: ${dir}`);
    expect(front?.[1]).toMatch(/\ndescription: .+|^description: .+/m);
  }
});

test("writing-a-custom-agent asks where the agent belongs before any code", () => {
  const text = readFileSync(join(skillsDir, "writing-a-custom-agent", "SKILL.md"), "utf8");
  expect(text).toContain("this repository only, or for the whole team");
});

test("onboarding asks for owner and system before it directs an agent to write catalog-info.yaml", () => {
  const text = readFileSync(join(skillsDir, "onboarding-a-repository", "SKILL.md"), "utf8");
  const ask = text.indexOf("Ask the engineer for the component owner and system.");
  const write = text.indexOf("Write `catalog-info.yaml`");
  expect(ask).toBeGreaterThanOrEqual(0);
  expect(write).toBeGreaterThan(ask);
  expect(text).toContain("Do not derive either value from the directory or Git remote.");
});
