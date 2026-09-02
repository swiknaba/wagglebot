import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec";
import { selectHarnesses } from "./harness-select";

const home = () => mkdtempSync(join(tmpdir(), "wgl-sel-"));
const configExec =
  (value: string): Exec =>
  async () => ({ code: value === "" ? 1 : 0, stdout: value, stderr: "" });

test("detects installed harnesses by their home directory, in table order", async () => {
  const h = home();
  mkdirSync(join(h, ".gemini"));
  mkdirSync(join(h, ".claude"));
  const result = await selectHarnesses(h, configExec(""));
  expect(result.source).toBe("detected");
  expect(result.harnesses.map((x) => x.name)).toEqual(["claude-code", "gemini"]);
});

test("git config wagglebot.harnesses overrides detection", async () => {
  const h = home();
  mkdirSync(join(h, ".claude"));
  const result = await selectHarnesses(h, configExec("codex, junie\n"));
  expect(result.source).toBe("config");
  expect(result.harnesses.map((x) => x.name)).toEqual(["codex", "junie"]);
});

test("an unknown name in the config is a hard error that lists the valid names", async () => {
  await expect(selectHarnesses(home(), configExec("cursor"))).rejects.toThrow(/cursor.*claude-code/s);
});

test("no detected harness is a hard error with the config hint", async () => {
  await expect(selectHarnesses(home(), configExec(""))).rejects.toThrow(/wagglebot\.harnesses/);
});
