import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBuilt, isolatedEnv, repoRoot, runCli } from "./helper";

// Compare the real company scaffold and offline additions with the committed fixture.
const REGEN_HINT = "run: bun run regen:test-app";
const testAppDir = join(repoRoot, "test-app");

// A local "yarn install" inside test-app/ leaves artifacts the scaffold never
// produces — ignore them, along with .git/ from a checkout.
const IGNORED = new Set([".git", "node_modules", "yarn.lock"]);

const walk = (dir: string, prefix = ""): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !IGNORED.has(entry.name))
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

test("company scaffold retains the exact pin and matches the offline test-app reference", () => {
  const target = join(scratchDir, "test-app");
  const result = runCli(["init", "--wagglebot", "test-app"], {
    cwd: scratchDir,
    env: isolatedEnv(join(scratchDir, "home")),
  });
  expect(result.status).toBe(0);
  expect(statSync(target).isDirectory()).toBe(true);

  // Preserve the exact scaffold pin. The test runs the branch build without an npm install.
  const pkgPath = join(target, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  expect(pkg.dependencies.wagglebot).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  execFileSync("node", [join(repoRoot, "scripts/regen-test-app.mjs"), "--prepare-fixture", target], {
    cwd: scratchDir,
    env: isolatedEnv(join(scratchDir, "home")),
  });

  const expectedFiles = walk(testAppDir);
  const actualFiles = walk(target);
  expect(actualFiles, `scaffolded file list differs from test-app/ — ${REGEN_HINT}`).toEqual(expectedFiles);

  for (const file of expectedFiles) {
    const expected = readFileSync(join(testAppDir, file));
    const actual = readFileSync(join(target, file));
    expect(actual.equals(expected), `content of "${file}" differs from test-app/${file} — ${REGEN_HINT}`).toBe(true);
  }
});
