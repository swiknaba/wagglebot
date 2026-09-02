import { expect, test } from "bun:test";
import type { Exec } from "../exec";
import { createReporter } from "../report";
import { runInstallSkills } from "./install-skills";

const quiet = () => createReporter(() => {}, false);
const HASH = "a".repeat(40);

const fakeExec =
  (calls: string[][]): Exec =>
  async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git") return { code: 0, stdout: `${HASH}\tHEAD\n`, stderr: "" };
    if (args.includes("fail/fail@v1")) return { code: 1, stdout: "", stderr: "clone failed" };
    if (args.includes("ok/ok@v1")) return { code: 0, stdout: "already installed", stderr: "" };
    return { code: 0, stdout: "installed", stderr: "" };
  };

test("installs each entry, counts, and exits non-zero on a failure", async () => {
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    listText: "new/new@v2\nok/ok@v1\nfail/fail@v1\n",
    listPath: "skills.list",
    exec: fakeExec(calls),
    reporter: r,
    skillsBin: "/bin/skills",
  });
  expect(code).toBe(1);
  expect(r.counts()).toMatchObject({ installed: 1, ok: 1, failed: 1 });
  expect(calls[0]).toEqual(["/bin/skills", "add", "new/new@v2", "-g", "-y"]);
});

test("--update rewrites pins to the remote HEAD hash for review", async () => {
  let written = "";
  const code = await runInstallSkills({
    listText: "# comment\nobra/superpowers@v4.2.0\n",
    listPath: "skills.list",
    exec: fakeExec([]),
    reporter: quiet(),
    skillsBin: "/bin/skills",
    update: true,
    writeList: (t) => {
      written = t;
    },
  });
  expect(code).toBe(0);
  expect(written).toContain(`obra/superpowers@${HASH}`);
  expect(written).toContain("# comment");
});

test("a missing list is skipped, exit 0", async () => {
  const code = await runInstallSkills({
    listText: undefined,
    listPath: "skills.list",
    exec: fakeExec([]),
    reporter: quiet(),
    skillsBin: "/bin/skills",
  });
  expect(code).toBe(0);
});
