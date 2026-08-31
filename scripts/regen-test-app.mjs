#!/usr/bin/env node
// Regenerates test-app/ from the real, built wagglebot CLI. Run this after any
// scaffold-template or version change, then commit the result. The e2e drift
// gate (packages/cli/e2e/scaffold.test.ts) fails when test-app/ falls behind
// what `wagglebot init` produces.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const cliDir = join(repoRoot, "packages", "cli");
const testAppDir = join(repoRoot, "test-app");

execFileSync("bun", ["run", "build"], { cwd: cliDir, stdio: "inherit" });

rmSync(testAppDir, { recursive: true, force: true });
mkdirSync(testAppDir, { recursive: true });

execFileSync("node", [join(cliDir, "bin", "wagglebot.js"), "init", "test-app"], {
  cwd: repoRoot,
  stdio: "inherit",
});

// The scaffold pins the published registry version, which is correct for real users.
// The committed reference app must install the CLI from this repo instead, so tests
// exercise the current branch. scaffold.test.ts applies the same rewrite before it
// diffs a fresh scaffold against test-app/ — keep the two in sync.
const pkgPath = join(testAppDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.dependencies.wagglebot = "file:../packages/cli";
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
