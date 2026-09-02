import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackupSet } from "../backup";
import { startBackupSet } from "../backup";
import { renderManagedBlock } from "../managed-block";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";

// .zshenv is read by every zsh, interactive or not, so IDE terminals and agent subprocesses
// see the variables. .bashrc is written only when it already exists.
export const SHELL_RC_FILES: { file: string; createIfMissing: boolean }[] = [
  { file: ".zshenv", createIfMissing: true },
  { file: ".bashrc", createIfMissing: false },
];

const SCRIPT = "node_modules/wagglebot/templates/shell/wagglebot.sh";

// The block names the company checkout and sources the script that ships in the package.
// A pin bump changes the script, never this block.
export const shellBlock = (companyRoot: string): string =>
  [
    `export WAGGLEBOT_COMPANY_REPO="${companyRoot}"`,
    `[ -r "$WAGGLEBOT_COMPANY_REPO/${SCRIPT}" ] && . "$WAGGLEBOT_COMPANY_REPO/${SCRIPT}"`,
  ].join("\n");

export function runSyncShell(deps: {
  home: string;
  companyRoot: string;
  reporter: Reporter;
  backups?: BackupSet;
}): number {
  const { home, reporter } = deps;
  const backups = deps.backups ?? startBackupSet(resolvePaths(home).backupsDir);
  reporter.section("Shell environment");
  if (!existsSync(join(deps.companyRoot, SCRIPT))) {
    reporter.item(
      SCRIPT,
      "failed",
      "not found under the company repository — run yarn install, then run this command again",
    );
  }
  for (const { file, createIfMissing } of SHELL_RC_FILES) {
    const target = join(home, file);
    try {
      if (!existsSync(target) && !createIfMissing) {
        reporter.item(file, "skipped", "file does not exist");
        continue;
      }
      const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
      const result = renderManagedBlock(existing, shellBlock(deps.companyRoot), "hash");
      if (!result.changed) {
        reporter.item(file, "ok", "already ok");
        continue;
      }
      backups.backup(target);
      writeFileSync(target, result.next);
      reporter.item(file, "updated", "synced — open a new terminal to load .env.credentials");
    } catch (error) {
      reporter.item(file, "failed", error instanceof Error ? error.message : String(error));
    }
  }
  return reporter.failed() ? 1 : 0;
}
