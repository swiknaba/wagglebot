import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
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
