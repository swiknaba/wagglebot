import { expect, test } from "bun:test";

import { GitRunner } from "./runner";

test("passes hostile arguments to Git without a shell", async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string; shell: false }> = [];
  const runner = new GitRunner(async (command, args, cwd) => {
    calls.push({ command, args, cwd, shell: false });
    return { stdout: "", stderr: "", exitCode: 0 };
  });

  await runner.run("/repo", ["log", "--", "$(touch pwned)"]);

  expect(calls).toEqual([{ command: "git", args: ["log", "--", "$(touch pwned)"], cwd: "/repo", shell: false }]);
});

test("rejects oversized Git output", async () => {
  const runner = new GitRunner(async () => ({ stdout: "x".repeat(1024 * 1024 + 1), stderr: "", exitCode: 0 }));

  await expect(runner.run("/repo", ["log"])).rejects.toMatchObject({ code: "local_brain_internal" });
});
