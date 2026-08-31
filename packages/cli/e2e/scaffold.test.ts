import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBuilt, repoRoot, runCli } from "./helper";

// test-app/ (committed at the repo root) is the reference output of `wagglebot init`.
// This test scaffolds into a throwaway directory with the real, built CLI and diffs the
// result against test-app/ file-by-file. A mismatch means test-app/ has drifted from what
// the CLI actually produces — regenerate it with `bun run regen:test-app` and commit it.
const REGEN_HINT = "run: bun run regen:test-app";
const testAppDir = join(repoRoot, "test-app");

const walk = (dir: string, prefix = ""): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    )
    .sort();

let scratchDir: string;

beforeAll(() => {
  ensureBuilt();
  scratchDir = mkdtempSync(join(tmpdir(), "wagglebot-scaffold-"));
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

test("wagglebot init matches the committed test-app/ reference, file by file", () => {
  const target = join(scratchDir, "test-app");
  const result = runCli(["init", "test-app"], { cwd: scratchDir });
  expect(result.status).toBe(0);
  expect(statSync(target).isDirectory()).toBe(true);

  const expectedFiles = walk(testAppDir);
  const actualFiles = walk(target);
  expect(actualFiles, `scaffolded file list differs from test-app/ — ${REGEN_HINT}`).toEqual(expectedFiles);

  for (const file of expectedFiles) {
    const expected = readFileSync(join(testAppDir, file));
    const actual = readFileSync(join(target, file));
    expect(actual.equals(expected), `content of "${file}" differs from test-app/${file} — ${REGEN_HINT}`).toBe(true);
  }
});
