import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestBackupSet, restoreSet } from "../backup";
import type { Exec } from "../exec";
import { resolvePaths } from "../paths";
import { createReporter } from "../report";
import { runUpdate } from "./update";

const scaffoldCompany = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wgl-co-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.4.2" } }));
  writeFileSync(
    join(root, "catalog.yaml"),
    "kind: Group\nmetadata: { name: t }\nspec: { members: [alice] }\n---\nkind: User\nmetadata: { name: alice }\nspec: { memberOf: [t] }\n",
  );
  writeFileSync(
    join(root, "registry.base.yaml"),
    "proxies:\n  - { namespace: ex, mode: remote_http, endpoint: https://ex/mcp }\n",
  );
  mkdirSync(join(root, "overlays"));
  return root;
};

const gitExec =
  (calls: string[][]): Exec =>
  async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args.includes("wagglebot.username")) return { code: 0, stdout: "alice\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

test("pulls, provisions, and prints a summary", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const calls: string[][] = [];
  const lines: string[] = [];
  const code = await runUpdate({
    cwd: root,
    home,
    exec: gitExec(calls),
    ask: async () => "alice",
    reporter: createReporter((l) => lines.push(l), false),
    write: (l) => lines.push(l),
    skillsBin: "/bin/skills",
  });
  expect(code).toBe(0);
  expect(calls[0]).toEqual(["git", "pull", "--ff-only"]);
  expect(lines.join("\n")).toContain("failed 0");
});

test("a moved pin triggers yarn install and a re-exec, once", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "pull") {
      // the pull moves the pin
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.5.0" } }));
    }
    if (cmd === "git" && args.includes("wagglebot.username")) return { code: 0, stdout: "alice\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const quiet = createReporter(() => {}, false);
  const code = await runUpdate({
    cwd: root,
    home,
    exec,
    ask: async () => "alice",
    reporter: quiet,
    write: () => {},
    skillsBin: "/bin/skills",
  });
  expect(code).toBe(0);
  expect(calls).toContainEqual(["yarn", "install"]);
  expect(calls).toContainEqual(["yarn", "wagglebot", "update", "--skip-self-update"]);
});

test("one runUpdate makes a single backup set that restores both CLAUDE.md and .claude.json", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# my personal rules\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { personal: { command: "my-mcp" } } }));

  const code = await runUpdate({
    cwd: root,
    home,
    exec: gitExec([]),
    ask: async () => "alice",
    reporter: createReporter(() => {}, false),
    write: () => {},
    skillsBin: "/bin/skills",
  });
  expect(code).toBe(0);

  const paths = resolvePaths(home);
  expect(readdirSync(paths.backupsDir)).toHaveLength(1);

  // Overwrite both files, then restore the newest (only) backup set and confirm both come back.
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# clobbered\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  const set = newestBackupSet(paths.backupsDir);
  expect(set).toBeDefined();
  const restored = restoreSet(set ?? "");
  expect(restored).toContain(join(home, ".claude/CLAUDE.md"));
  expect(restored).toContain(join(home, ".claude.json"));
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("# my personal rules\n");
  const doc: { mcpServers: { personal?: unknown } } = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(doc.mcpServers.personal).toBeDefined();
});
