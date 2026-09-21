import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newestBackupSet, restoreSet } from "../backup";
import { HARNESSES } from "../harness";
import { createReporter } from "../report";
import { restoreHarnesses, runSyncHarnesses } from "./sync-harnesses";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  homes.push(home);
  const instructionsDir = join(home, "company-instructions");
  mkdirSync(instructionsDir);
  writeFileSync(join(instructionsDir, "10-team.md"), "## Team Instructions\n");
  return { home, instructionsDir };
};
const quiet = () => createReporter(() => {}, false);

test("writes every template target inside a managed block, chmod 600", () => {
  const { home, instructionsDir } = setup();
  const code = runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [instructionsDir], reporter: quiet() });
  expect(code).toBe(0);
  const claude = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  expect(claude).toContain("<!-- wagglebot:begin -->");
  expect(claude).toContain("## Team Instructions");
  expect(claude).toContain("## Memory");
  expect(statSync(join(home, ".claude/CLAUDE.md")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(home, ".gemini/GEMINI.md"))).toBe(true);
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  expect(JSON.stringify(settings.hooks)).toContain("wagglebot:");
  expect(statSync(join(home, ".claude/settings.json")).mode & 0o777).toBe(0o600);
});

test("the shared base prompt offers a requirements interview for substantial unspecced work", () => {
  const { home, instructionsDir } = setup();
  runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [instructionsDir], reporter: quiet() });

  const claude = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  expect(claude).toContain("## Requirements Interviews");
  expect(claude).toContain("offer a requirements interview");
  expect(claude).toContain("use the `brainstorming` skill");
});

test("second run reports every item ok and changes nothing", () => {
  const { home, instructionsDir } = setup();
  runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [instructionsDir], reporter: quiet() });
  const before = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  const r = createReporter(() => {}, false);
  expect(runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [instructionsDir], reporter: r })).toBe(0);
  expect(r.counts().updated).toBe(0);
  expect(r.counts().ok).toBeGreaterThan(0);
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe(before);
});

test("content outside the managed block survives, and --restore brings the old file back", () => {
  const { home, instructionsDir } = setup();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# My personal rules\n");
  runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [instructionsDir], reporter: quiet() });
  const synced = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  expect(synced.startsWith("# My personal rules")).toBe(true);
  restoreHarnesses({
    home,
    reporter: quiet(),
  });
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("# My personal rules\n");
});

test("a corrupt settings.json fails the hooks merge but other targets still get written", () => {
  const { home, instructionsDir } = setup();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), "{ not valid json");
  const r = createReporter(() => {}, false);
  const code = runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [instructionsDir], reporter: r });
  expect(code).toBe(1);
  expect(r.counts().failed).toBeGreaterThan(0);
  // The CLAUDE.md target (a separate harness target) still gets written.
  expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(true);
  expect(existsSync(join(home, ".gemini/GEMINI.md"))).toBe(true);
});

test("writes only the selected harnesses and appends team instructions after company ones", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  homes.push(home);
  const company = join(home, "co");
  const team = join(home, "team");
  mkdirSync(company);
  mkdirSync(team);
  writeFileSync(join(company, "00.md"), "## Company\n");
  writeFileSync(join(team, "00.md"), "## Team\n");
  const codex = HARNESSES.find((h) => h.name === "codex");
  if (codex === undefined) throw new Error("codex missing");
  runSyncHarnesses({ home, harnesses: [codex], instructionDirs: [company, team], reporter: quiet() });
  expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(false);
  const text = readFileSync(join(home, ".codex/AGENTS.md"), "utf8");
  expect(text.indexOf("## Company")).toBeLessThan(text.indexOf("## Team"));
});

test("a corrupt hook fragment fails the hooks item only, and the template targets still sync", () => {
  const { home, instructionsDir } = setup();
  const fragmentsDir = mkdtempSync(join(tmpdir(), "wgl-frag-"));
  homes.push(fragmentsDir);
  writeFileSync(join(fragmentsDir, "claude-code.json"), "{ not json");
  const r = createReporter(() => {}, false);
  const code = runSyncHarnesses({
    home,
    harnesses: HARNESSES.filter((h) => h.name === "claude-code"),
    instructionDirs: [instructionsDir],
    reporter: r,
    fragmentsDir,
  });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
  expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(true);
});

const instructionTargets = [
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

const objectHookTargets = [
  { path: ".claude/settings.json", event: "PostToolUse", nested: true, tools: ["Write", "Edit"] },
  { path: ".gemini/settings.json", event: "AfterTool", nested: true, tools: ["write_file", "replace"] },
  { path: ".copilot/hooks/wagglebot.json", event: "postToolUse", nested: false, version: 1 },
  { path: ".cursor/hooks.json", event: "afterFileEdit", nested: false, version: 1 },
  { path: ".config/devin/config.json", event: "PostToolUse", nested: true, tools: ["write", "edit", "apply_patch"] },
  { path: ".codeium/windsurf/hooks.json", event: "post_write_code", nested: false },
];

const put = (home: string, path: string, text: string) => {
  const target = join(home, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
};

const sync = (home: string, overwriteLocal = false) =>
  runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [], reporter: quiet(), overwriteLocal });

test("creates every global instruction target without installed harness directories", () => {
  const { home } = setup();
  expect(sync(home)).toBe(0);
  for (const path of instructionTargets) {
    const text = readFileSync(join(home, path), "utf8");
    expect(text).toContain("ASD-STE100");
    expect(text).toContain(".agents/changelog.md");
    expect(text).toContain("<!-- wagglebot:begin -->");
    expect(statSync(join(home, path)).mode & 0o777).toBe(0o600);
  }
});

test("preserves personal text before and after every managed instruction block", () => {
  const { home } = setup();
  for (const path of instructionTargets) {
    put(home, path, "# Personal\n\n<!-- wagglebot:begin -->\nold rules\n<!-- wagglebot:end -->\n# Footer\n");
  }
  expect(sync(home)).toBe(0);
  for (const path of instructionTargets) {
    const text = readFileSync(join(home, path), "utf8");
    expect(text.startsWith("# Personal\n\n")).toBe(true);
    expect(text.endsWith("\n# Footer\n")).toBe(true);
    expect(text).not.toContain("old rules");
  }
});

for (const target of objectHookTargets) {
  test(`writes and preserves ${target.event} hooks in ${target.path}`, () => {
    const { home } = setup();
    const foreign = target.nested
      ? { matcher: "Read", hooks: [{ type: "command", command: "personal-hook" }] }
      : { type: "command", command: "personal-hook", bash: "personal-hook" };
    put(home, target.path, JSON.stringify({ theme: "dark", hooks: { [target.event]: [foreign], Other: [foreign] } }));
    expect(sync(home)).toBe(0);
    const doc = JSON.parse(readFileSync(join(home, target.path), "utf8"));
    expect(doc.theme).toBe("dark");
    expect(doc.hooks.Other).toEqual([foreign]);
    expect(doc.hooks[target.event]).toHaveLength(2);
    expect(doc.hooks[target.event][0]).toEqual(foreign);
    if (target.version !== undefined) expect(doc.version).toBe(target.version);
    const entry = doc.hooks[target.event][1];
    if (target.tools !== undefined) {
      for (const tool of target.tools) expect(new RegExp(entry.matcher).test(tool)).toBe(true);
      expect(new RegExp(entry.matcher).test("read_file")).toBe(false);
    }
    const action = target.nested ? entry.hooks[0] : entry;
    expect(action.type ?? "command").toBe("command");
    const result = spawnSync("/bin/sh", ["-c", action.bash ?? action.command], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "src/main.ts" }, tool_response: {} }),
      encoding: "utf8",
      cwd: home,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("ASD-STE100");
    expect(result.stdout).toContain(".agents/changelog.md");
    if (target.nested) {
      expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe(target.event);
      expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain(".agents/changelog.md");
    } else if (target.event === "postToolUse") {
      expect(JSON.parse(result.stdout).additionalContext).toContain(".agents/changelog.md");
    }
    const before = readFileSync(join(home, target.path), "utf8");
    expect(sync(home)).toBe(0);
    expect(readFileSync(join(home, target.path), "utf8")).toBe(before);
  });
}

test("writes Kiro v1 PostFileSave commands with a Markdown matcher and preserves foreign hooks", () => {
  const { home } = setup();
  const path = ".kiro/hooks/wagglebot.json";
  const foreign = { name: "Personal", trigger: "PostFileSave", action: { type: "command", command: "personal" } };
  put(home, path, JSON.stringify({ version: "v1", hooks: [foreign] }));
  expect(sync(home)).toBe(0);
  const doc = JSON.parse(readFileSync(join(home, path), "utf8"));
  expect(doc.version).toBe("v1");
  expect(doc.hooks).toHaveLength(2);
  expect(doc.hooks[0]).toEqual(foreign);
  const entry = doc.hooks[1];
  expect(entry.trigger).toBe("PostFileSave");
  expect(entry.matcher).toBe("\\.md$");
  expect(new RegExp(entry.matcher).test("docs/readme.md")).toBe(true);
  expect(new RegExp(entry.matcher).test("docs/readme.mdx")).toBe(false);
  expect(entry.action.type).toBe("command");
  const result = spawnSync("/bin/sh", ["-c", entry.action.command], { encoding: "utf8", cwd: home, input: "{}" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("ASD-STE100");
  expect(result.stdout).toContain(".agents/changelog.md");
  const before = readFileSync(join(home, path), "utf8");
  expect(sync(home)).toBe(0);
  expect(readFileSync(join(home, path), "utf8")).toBe(before);
});

test("reports unsupported hooks without a failure or a missing instruction target", () => {
  const { home } = setup();
  const lines: string[] = [];
  const reporter = createReporter((line) => lines.push(line), false);
  expect(runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [], reporter })).toBe(0);
  for (const name of ["codex", "junie", "cline"]) {
    expect(lines.some((line) => line.includes(name) && line.includes("unsupported") && line.includes("skipped"))).toBe(
      true,
    );
  }
  expect(reporter.counts().skipped).toBe(3);
});

test("uses one backup set for changed existing files and no new set for an unchanged run", () => {
  const { home } = setup();
  put(home, ".claude/CLAUDE.md", "Personal rules\n");
  put(home, ".gemini/settings.json", '{"theme":"dark"}');
  expect(sync(home)).toBe(0);
  const backupsDir = join(home, ".wagglebot/backups");
  expect(readdirSync(backupsDir)).toHaveLength(1);
  const set = newestBackupSet(backupsDir);
  if (set === undefined) throw new Error("Backup set missing");
  expect(readdirSync(set)).toHaveLength(2);
  expect(sync(home)).toBe(0);
  expect(readdirSync(backupsDir)).toHaveLength(1);
  expect(readdirSync(set)).toHaveLength(2);
  expect(restoreSet(set).failed).toEqual([]);
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("Personal rules\n");
  expect(readFileSync(join(home, ".gemini/settings.json"), "utf8")).toBe('{"theme":"dark"}');
});

test("overwrite replaces dedicated instructions and hook categories without a backup", () => {
  const { home } = setup();
  for (const path of instructionTargets) put(home, path, "Personal instructions\n<!-- wagglebot:begin -->\nmalformed");
  for (const target of objectHookTargets) {
    put(
      home,
      target.path,
      JSON.stringify({ theme: "dark", model: "personal", keybindings: ["ctrl+k"], hooks: { Old: [] } }),
    );
  }
  put(home, ".kiro/hooks/wagglebot.json", '{"version":"old","personal":true,"hooks":[]}');
  expect(sync(home, true)).toBe(0);
  for (const path of instructionTargets) {
    const text = readFileSync(join(home, path), "utf8");
    expect(text).toContain("ASD-STE100");
    expect(text).not.toContain("Personal instructions");
    expect(text).not.toContain("<!-- wagglebot:");
  }
  for (const target of objectHookTargets) {
    const doc = JSON.parse(readFileSync(join(home, target.path), "utf8"));
    expect(Object.keys(doc.hooks)).toEqual([target.event]);
    if (target.path === ".copilot/hooks/wagglebot.json") {
      expect(Object.keys(doc).sort()).toEqual(["hooks", "version"]);
    } else {
      expect(doc.theme).toBe("dark");
      expect(doc.model).toBe("personal");
      expect(doc.keybindings).toEqual(["ctrl+k"]);
    }
  }
  const kiro = JSON.parse(readFileSync(join(home, ".kiro/hooks/wagglebot.json"), "utf8"));
  expect(Object.keys(kiro).sort()).toEqual(["hooks", "version"]);
  expect(kiro.version).toBe("v1");
  expect(kiro.hooks).toHaveLength(1);
  expect(existsSync(join(home, ".wagglebot/backups"))).toBe(false);
});

test("overwrite does not call a supplied backup set", () => {
  const { home } = setup();
  put(home, ".claude/CLAUDE.md", "Old rules\n");
  const code = runSyncHarnesses({
    home,
    harnesses: HARNESSES,
    instructionDirs: [],
    reporter: quiet(),
    overwriteLocal: true,
    backups: {
      dir: "unused",
      backup() {
        throw new Error("Backup must not run");
      },
    },
  });
  expect(code).toBe(0);
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).not.toContain("Old rules");
});

for (const overwriteLocal of [false, true]) {
  test(`continues independent targets after malformed shared JSON with overwrite=${overwriteLocal}`, () => {
    const { home } = setup();
    put(home, ".gemini/settings.json", "{ broken");
    const reporter = quiet();
    expect(runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [], reporter, overwriteLocal })).toBe(1);
    expect(reporter.counts().failed).toBe(1);
    expect(readFileSync(join(home, ".gemini/settings.json"), "utf8")).toBe("{ broken");
    expect(existsSync(join(home, ".kiro/hooks/wagglebot.json"))).toBe(true);
    for (const path of instructionTargets) expect(existsSync(join(home, path))).toBe(true);
  });
}

test("--restore reports a file it cannot restore as failed and exits 1", () => {
  const { home, instructionsDir } = setup();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# Mine\n");
  runSyncHarnesses({ home, harnesses: HARNESSES, instructionDirs: [instructionsDir], reporter: quiet() });
  rmSync(join(home, ".claude"), { recursive: true }); // the restore target directory is gone
  const r = createReporter(() => {}, false);
  const code = restoreHarnesses({ home, reporter: r });
  expect(code).toBe(1);
  expect(r.counts().failed).toBeGreaterThan(0);
});
