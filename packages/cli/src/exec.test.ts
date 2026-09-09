import { expect, test } from "bun:test";
import { realExec } from "./exec";

test("realExec returns stdout and exit code 0 on success", async () => {
  const result = await realExec(process.execPath, ["-e", "process.stdout.write('hi')"]);
  expect(result).toEqual({ code: 0, stdout: "hi", stderr: "" });
});

test("realExec does not mark a program that exits 127 as missing", async () => {
  const result = await realExec(process.execPath, ["-e", "process.exit(127)"]);
  expect(result.code).toBe(127);
  expect(result.notFound).toBeUndefined();
});

test("realExec returns the exit code and stderr of a failing command", async () => {
  const result = await realExec(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(3)"]);
  expect(result.code).toBe(3);
  expect(result.stderr).toBe("bad");
});

test("realExec maps a command that does not exist to 127", async () => {
  const result = await realExec("wagglebot-command-that-does-not-exist", []);
  expect(result.code).toBe(127);
  expect(result.notFound).toBe(true);
});

test("realExec runs in the given cwd", async () => {
  const result = await realExec(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: "/" });
  expect(result.stdout).toBe("/");
});
