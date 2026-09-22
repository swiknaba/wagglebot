import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fixtureRepo } from "../memory/test-fixture";
import { GitProvider } from "./provider";

const commit = (repo: string, message: string): void => {
  Bun.spawnSync(["git", "add", "."], { cwd: repo });
  Bun.spawnSync(
    [
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      message,
    ],
    {
      cwd: repo,
    },
  );
};

test("returns bounded local history without sending a query to Git", async () => {
  const repo = fixtureRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "token.ts"), "export const rotate = () => 'first';\n");
  commit(repo, "add token rotation");
  writeFileSync(join(repo, "src", "token.ts"), "export const rotate = () => 'second';\n");
  commit(repo, "rotate once after payment retry");
  const provider = new GitProvider();

  const history = await provider.history({ projectRoot: repo, path: "src/token.ts", limit: 10 });
  const why = await provider.why({ projectRoot: repo, path: "src/token.ts", query: "why rotate once" });

  expect(history.commits).toHaveLength(2);
  expect(why.evidence[0]?.reason).toBe("bm25");
  expect(why.evidence).toHaveLength(2);
});

test("ranks blamed lines above keyword-only history and returns bounded diff evidence", async () => {
  const repo = fixtureRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "token.ts"), "export const rotate = () => 'first';\n");
  commit(repo, "add token rotation");
  writeFileSync(join(repo, "src", "token.ts"), "export const rotate = () => 'second';\n");
  commit(repo, "rotate once after payment retry");

  const why = await new GitProvider().why({
    projectRoot: repo,
    path: "src/token.ts",
    startLine: 1,
    endLine: 1,
    query: "add token rotation",
  });

  expect(why.evidence[0]).toMatchObject({ reason: "blame", subject: "rotate once after payment retry" });
  expect(why.evidence[0]?.diffHunks.join("\n")).toContain("second");
  expect(why.evidence).toHaveLength(2);
});
