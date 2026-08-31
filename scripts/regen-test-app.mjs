#!/usr/bin/env node
// Regenerates test-app/ from the real, built wagglebot CLI. Run this after any
// scaffold-template or version change, then commit the result. The e2e drift
// gate (packages/cli/e2e/scaffold.test.ts) fails when test-app/ falls behind
// what `wagglebot init` produces.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
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
