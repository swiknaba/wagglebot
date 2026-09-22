import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseToml } from "smol-toml";
import { commitAll, ensureBuilt, git, initGit, isolatedEnv, repoRoot, runCli, snapshot } from "./helper";

let scratch: string;
beforeAll(() => {
  ensureBuilt();
  scratch = mkdtempSync(join(tmpdir(), "wagglebot-offline-company-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Literal paths also detect omissions from the production capability table.
const instructions = [
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  ".junie/AGENTS.md",
  ".gemini/GEMINI.md",
  ".copilot/copilot-instructions.md",
  ".cline/rules/wagglebot.md",
  ".cursor/rules/wagglebot.mdc",
  ".config/devin/AGENTS.md",
  ".codeium/windsurf/memories/global_rules.md",
  ".kiro/steering/AGENTS.md",
];
const skills = [
  // Codex, Gemini, Copilot, Cline, and Cursor use the shared directory in skills 1.5.23.
  ".claude/skills",
  ".junie/skills",
  ".agents/skills",
  ".config/devin/skills",
  ".codeium/windsurf/skills",
  ".kiro/skills",
];
const agents = [
  ".claude/agents",
  ".junie/agents",
  ".gemini/agents",
  ".copilot/agents",
  ".cursor/agents",
  ".config/devin/agents",
  ".kiro/agents",
];
const hooks = [
  [".claude/settings.json", "PostToolUse"],
  [".gemini/settings.json", "AfterTool"],
  [".copilot/hooks/wagglebot.json", "postToolUse"],
  [".cursor/hooks.json", "afterFileEdit"],
  [".config/devin/config.json", "PostToolUse"],
  [".codeium/windsurf/hooks.json", "post_write_code"],
  [".kiro/hooks/wagglebot.json", "PostFileSave"],
];
const mcp = [
  ".claude.json",
  ".codex/config.toml",
  ".junie/mcp/mcp.json",
  ".gemini/settings.json",
  ".copilot/mcp-config.json",
  ".cline/data/settings/cline_mcp_settings.json",
  ".cursor/mcp.json",
  ".config/devin/mcp_config.json",
  ".codeium/windsurf/mcp_config.json",
  ".kiro/settings/mcp.json",
];

test("plain company update provisions all nine harnesses offline and leaves the copied Git worktree clean", () => {
  const app = join(scratch, "test-app");
  const home = join(scratch, "home");
  const env = isolatedEnv(home);
  cpSync(join(repoRoot, "test-app"), app, {
    recursive: true,
    filter: (path) => ![".git", "node_modules"].includes(path.split("/").at(-1) ?? ""),
  });
  initGit(app, env);
  commitAll(app, env);
  expect(existsSync(join(app, "wagglebot.yaml"))).toBe(true);
  expect(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).dependencies.wagglebot).toMatch(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  );

  const remotes = join(scratch, "remotes");
  mkdirSync(remotes);
  for (const kind of ["skills", "agents"]) {
    const source = join(remotes, `${kind}.git`);
    const alias = `ssh://offline.invalid/${kind}.git`;
    cpSync(join(app, "fixtures", kind), source, { recursive: true });
    initGit(source, env);
    commitAll(source, env);
    git(source, env, "tag", "v1.0.0");
    expect(git(source, env, "tag", "--list")).toBe("v1.0.0\n");
    git(app, env, "config", "--global", `url.${pathToFileURL(source).href}.insteadOf`, alias);
    expect(git(app, env, "config", "--global", "--get", `url.${pathToFileURL(source).href}.insteadOf`).trim()).toBe(
      alias,
    );
    // A later commit proves that the real installer selects the tag.
    const file = kind === "skills" ? "SKILL.md" : "review.md";
    writeFileSync(
      join(source, file),
      readFileSync(join(source, file), "utf8").replace("pinned fixture", "unreleased fixture"),
    );
    commitAll(source, env);
    const list = join(app, kind === "skills" ? "company" : "teams/team-payments", `${kind}.list`);
    writeFileSync(list, `${alias} v1.0.0\n`);
    expect(readFileSync(list, "utf8")).toBe(`${alias} v1.0.0\n`);
  }
  git(app, env, "config", "--global", "wagglebot.username", "alice");
  commitAll(app, env);
  mkdirSync(join(app, "node_modules/wagglebot/templates/shell"), { recursive: true });
  cpSync(
    join(repoRoot, "packages/cli/templates/shell/wagglebot.sh"),
    join(app, "node_modules/wagglebot/templates/shell/wagglebot.sh"),
  );

  const first = runCli(["update"], { cwd: app, env });
  expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
  const stages = [...first.stdout.matchAll(/^== (.+) ==$/gm)].map((match) => match[1]);
  expect(stages).toEqual([
    ...Array(9).fill("Skills"),
    ...Array(9).fill("Custom agents"),
    ...Array(9).fill("Base template sync"),
    "Shell environment",
    ...Array(9).fill("MCP configs"),
  ]);
  expect(first.stdout.match(/^installed \d+.*failed \d+.*$/gm)).toHaveLength(1);
  const read = (path: string) => readFileSync(join(home, path), "utf8");
  for (const path of instructions) {
    const content = read(path);
    expect(content, path).toContain("Company fixture instructions.");
    expect(content, path).toContain("Payments fixture instructions.");
    expect(content, path).toContain("## Memory");
    expect(content, path).toContain("## Agent Changelog");
  }
  for (const path of skills) {
    expect(read(`${path}/offline-review/SKILL.md`), path).toContain("pinned fixture skill");
    expect(read(`${path}/offline-review/SKILL.md`), path).not.toContain("unreleased fixture");
  }
  expect(JSON.parse(read(".wagglebot/managed.json")).skills["ssh://offline.invalid/skills.git v1.0.0"]).toEqual([
    "claude-code",
    "cline",
    "codex",
    "cursor",
    "devin",
    "gemini-cli",
    "github-copilot",
    "junie",
    "kiro-cli",
    "windsurf",
  ]);
  for (const path of agents) {
    expect(read(`${path}/company__review.md`), path).toContain("Company fixture agent.");
    expect(read(`${path}/team-payments__review.md`), path).toContain("Payments fixture agent.");
    const remote = readdirSync(join(home, path)).find((file) => file.endsWith("agents__review.md"));
    expect(remote, path).toBeDefined();
    expect(read(`${path}/${remote}`), path).toContain("pinned fixture agent");
    expect(read(`${path}/${remote}`), path).not.toContain("unreleased fixture");
  }
  for (const [path = "", event = ""] of hooks) {
    const content = read(path);
    const config = JSON.parse(content);
    if (path === ".kiro/hooks/wagglebot.json") {
      expect(config.hooks[0].trigger).toBe(event);
      expect(config.hooks[0].matcher).toBe("\\.md$");
      expect(config.hooks[0].action.type).toBe("command");
    } else expect(config.hooks[event], path).toBeArray();
    expect(content, path).toContain(".agents/changelog.md");
    expect(content, path).toContain("ASD-STE100");
  }
  for (const harness of ["codex", "cline"]) {
    expect(first.stdout).toContain(`Custom agents are unsupported: ${harness}`);
  }
  for (const harness of ["codex", "junie", "cline"]) {
    expect(first.stdout).toMatch(new RegExp(`^  skipped\\s+${harness} hooks`, "m"));
  }
  expect(read(".zshenv")).toContain("# wagglebot:begin");
  expect(read(".zshenv")).toContain(app);
  for (const path of mcp) {
    const content = read(path);
    const servers = path.endsWith(".toml") ? parseToml(content).mcp_servers : JSON.parse(content).mcpServers;
    expect(servers, path).toMatchObject({
      "fixture-company": { command: "fixture-company-server" },
      "fixture-payments": { command: "fixture-payments-server" },
    });
  }
  expect(readFileSync(join(app, ".env.credentials.example"), "utf8")).toContain("# EXAMPLE_TOKEN=");
  expect(existsSync(join(app, ".env.credentials"))).toBe(false);
  expect(git(app, env, "status", "--porcelain")).toBe("");
  const outputs = [...instructions, ...hooks.map(([path]) => path ?? ""), ...mcp, ".zshenv", ".wagglebot/managed.json"];
  const before = Object.fromEntries(outputs.map((path) => [path, read(path)]));
  const installedBefore = Object.fromEntries([...skills, ...agents].map((path) => [path, snapshot(join(home, path))]));
  const second = runCli(["update"], { cwd: app, env });
  expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
  expect(second.stdout).toMatch(/^installed 0, ok \d+ .*updated 0,.*failed 0$/m);
  expect(second.stdout).not.toMatch(/^ {2}(?:installed|updated|failed)\s/m);
  expect(Object.fromEntries(outputs.map((path) => [path, read(path)]))).toEqual(before);
  expect(Object.fromEntries([...skills, ...agents].map((path) => [path, snapshot(join(home, path))]))).toEqual(
    installedBefore,
  );
  expect(git(app, env, "status", "--porcelain")).toBe("");
}, 120_000);
