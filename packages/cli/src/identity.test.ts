import { expect, test } from "bun:test";
import type { Exec } from "./exec";
import { getUsername } from "./identity";

test("a failed username write fails identity collection", async () => {
  const exec: Exec = async (_cmd, args) => ({
    code: args.length === 3 ? 1 : 2,
    stdout: "",
    stderr: "Cannot write Git config",
  });
  await expect(getUsername(exec, async () => "alice")).rejects.toThrow("Cannot store");
});

test("a Git config read failure does not prompt or replace the value", async () => {
  const exec: Exec = async () => ({ code: 2, stdout: "", stderr: "Invalid Git config" });
  await expect(
    getUsername(exec, async () => {
      throw new Error("Unexpected prompt");
    }),
  ).rejects.toThrow("Cannot read");
});

test("returns a stored username without a catalog or prompt", async () => {
  const exec: Exec = async () => ({ code: 0, stdout: " ghost\n", stderr: "" });
  expect(
    await getUsername(exec, async () => {
      throw new Error("Unexpected prompt");
    }),
  ).toBe("ghost");
});

test("prompts once and stores the answer without a catalog", async () => {
  const writes: string[][] = [];
  let prompts = 0;
  const exec: Exec = async (_cmd, args) => {
    if (args.length === 3) return { code: 1, stdout: "", stderr: "" };
    writes.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  expect(
    await getUsername(exec, async () => {
      prompts += 1;
      return " alice ";
    }),
  ).toBe("alice");
  expect(prompts).toBe(1);
  expect(writes).toEqual([["config", "--global", "wagglebot.username", "alice"]]);
});
