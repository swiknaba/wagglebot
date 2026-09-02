import { expect, test } from "bun:test";
import { loadCatalog } from "./catalog";
import type { Exec } from "./exec";
import { getUsername } from "./identity";

const catalog = loadCatalog(
  `kind: Group\nmetadata: { name: t }\nspec: { members: [alice] }\n---\nkind: User\nmetadata: { name: alice }\nspec: { memberOf: [t] }\n`,
  "catalog.yaml",
);

const fakeExec =
  (stored: string, writes: string[][]): Exec =>
  async (_cmd, args) => {
    if (args.includes("wagglebot.username") && args.length === 3)
      return { code: stored === "" ? 1 : 0, stdout: `${stored}\n`, stderr: "" };
    writes.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };

test("returns the stored username when it matches the catalog", async () => {
  expect(await getUsername(fakeExec("alice", []), async () => "never", catalog)).toBe("alice");
});

test("asks once, validates, and stores on first run", async () => {
  const writes: string[][] = [];
  expect(await getUsername(fakeExec("", writes), async () => " alice ", catalog)).toBe("alice");
  expect(writes).toEqual([["config", "--global", "wagglebot.username", "alice"]]);
});

test("rejects a non-matching answer with near matches", async () => {
  await expect(getUsername(fakeExec("", []), async () => "alcie", catalog)).rejects.toThrow(/alice/);
});

test("rejects a stored value that no longer matches", async () => {
  await expect(getUsername(fakeExec("ghost", []), async () => "n/a", catalog)).rejects.toThrow(/ghost/);
});
