import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec";
import { selectAndAnnounce, selectHarnesses } from "./harness-select";

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

test("selectAndAnnounce writes a one-line summary naming the harness and the config key", async () => {
  const h = home();
  mkdirSync(join(h, ".claude"));
  const lines: string[] = [];
  const harnesses = await selectAndAnnounce(h, configExec(""), (line) => lines.push(line));
  expect(harnesses.map((x) => x.name)).toEqual(["claude-code"]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("claude-code");
  expect(lines[0]).toContain("wagglebot.harnesses");
});
