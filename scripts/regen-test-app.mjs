#!/usr/bin/env node
// Regenerate the offline company fixture from the real CLI scaffold.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const cliDir = join(repoRoot, "packages", "cli");
const testAppDir = join(repoRoot, "test-app");

// These deterministic fixture additions replace sources that require a network.
// E2E tests copy the source directories into temporary tagged Git repositories.
function prepareFixture(target) {
  if (!existsSync(join(target, "wagglebot.yaml"))) throw new Error("The company scaffold marker is missing.");
  const files = {
    "company/skills.list": "# The E2E test supplies a tagged local source from fixtures/skills.\n",
    "company/agents.list": "# Company agents live in company/agents.\n",
    "teams/team-payments/skills.list": "# This team uses the company skill.\n",
    "teams/team-payments/agents.list": "# The E2E test supplies a tagged local source from fixtures/agents.\n",
    "company/instructions/00-example.md": "# Company\n\nCompany fixture instructions.\n",
    "teams/team-payments/instructions/00-example.md": "# Payments\n\nPayments fixture instructions.\n",
    "company/agents/review.md": "---\nname: company-review\ndescription: Review company changes.\n---\n\nCompany fixture agent.\n",
    "teams/team-payments/agents/review.md": "---\nname: payments-review\ndescription: Review payment changes.\n---\n\nPayments fixture agent.\n",
    "fixtures/skills/SKILL.md": "---\nname: offline-review\ndescription: Review the offline fixture.\n---\n\nUse the pinned fixture skill.\n",
    "fixtures/agents/review.md": "---\nname: offline-review\ndescription: Review the offline fixture.\n---\n\nUse the pinned fixture agent.\n",
    "company/registry.yaml": "# The test writes configuration but never starts this command.\nproxies:\n  - namespace: fixture-company\n    mode: stdio_cmd\n    command: fixture-company-server\n",
    "teams/team-payments/registry.yaml": "# The test writes configuration but never starts this command.\nproxies:\n  - namespace: fixture-payments\n    mode: stdio_cmd\n    command: fixture-payments-server\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), text);
  }
}

if (process.argv[2] === "--prepare-fixture" && process.argv.length === 4) {
  prepareFixture(resolve(process.argv[3]));
} else if (process.argv.length === 2) {
  execFileSync("bun", ["run", "build"], { cwd: cliDir, stdio: "inherit" });
  const scratch = mkdtempSync(join(tmpdir(), "wagglebot-regen-"));
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, ".config"),
    GIT_CONFIG_GLOBAL: join(scratch, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    SHELL: "/bin/zsh",
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  };
  try {
    rmSync(testAppDir, { recursive: true, force: true });
    execFileSync("node", [join(cliDir, "bin", "wagglebot.js"), "init", "--wagglebot", "test-app"], {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    });
    prepareFixture(testAppDir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  throw new Error("Use no arguments, or --prepare-fixture <company-scaffold>.");
}
