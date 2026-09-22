import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BackupSet } from "../backup";
import { startBackupSet } from "../backup";
import { migrateCachedCredentials, recordCachedShellReady } from "../company-cache";
import { renderManagedBlock } from "../managed-block";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";

// One startup file per supported shell. Every zsh reads .zshenv, interactive or not, so IDE
// terminals and agent subprocesses see the variables. bash reads .bashrc. `siblings` names the
// other startup files of that shell, whose presence proves the engineer uses it.
export const SHELL_RC_FILES: { file: string; shell: string; siblings: string[] }[] = [
  { file: ".zshenv", shell: "zsh", siblings: [".zshenv", ".zshrc", ".zprofile", ".zlogin"] },
  { file: ".bashrc", shell: "bash", siblings: [".bashrc", ".bash_profile", ".bash_login"] },
];

const FALLBACK_RC = ".zshenv";

// A startup file that exists always gets the block. A missing one is created only when the
// engineer uses that shell, which $SHELL or a sibling startup file proves. So a bash-only WSL
// distribution never gets a .zshenv that nothing reads, and a zsh-only macOS home never gets a
// .bashrc that nothing reads. An unset or unknown $SHELL falls back to .zshenv.
export function shellRcTargets(
  home: string,
  env: Record<string, string | undefined> = process.env,
): { file: string; shell: string; createIfMissing: boolean }[] {
  const login = basename(env.SHELL ?? "");
  const known = SHELL_RC_FILES.some((entry) => entry.shell === login);
  return SHELL_RC_FILES.map(({ file, shell, siblings }) => ({
    file,
    shell,
    createIfMissing:
      (known ? shell === login : file === FALLBACK_RC) || siblings.some((s) => existsSync(join(home, s))),
  }));
}

const SCRIPT = "node_modules/wagglebot/templates/shell/wagglebot.sh";

// Keep the company source separate from the selected runtime script.
// Working trees retain the original package-relative script path.
export const shellBlock = (companyRoot: string, shellScriptPath?: string, credentialsFile?: string): string =>
  [
    `export WAGGLEBOT_COMPANY_REPO="${companyRoot}"`,
    `export WAGGLEBOT_CREDENTIALS_FILE='${(credentialsFile ?? join(companyRoot, ".env.credentials")).replaceAll("'", "'\\''")}'`,
    shellScriptPath === undefined
      ? `[ -r "$WAGGLEBOT_COMPANY_REPO/${SCRIPT}" ] && . "$WAGGLEBOT_COMPANY_REPO/${SCRIPT}"`
      : `[ -r '${shellScriptPath.replaceAll("'", "'\\''")}' ] && . '${shellScriptPath.replaceAll("'", "'\\''")}'`,
  ].join("\n");

export function runSyncShell(deps: {
  home: string;
  companyRoot: string;
  shellScriptPath?: string;
  credentialsFile?: string;
  reporter: Reporter;
  backups?: BackupSet | false;
  env?: Record<string, string | undefined>;
}): number {
  const { home, reporter } = deps;
  const backups = deps.backups === false ? undefined : (deps.backups ?? startBackupSet(resolvePaths(home).backupsDir));
  reporter.section("Shell environment");
  const failuresBefore = reporter.counts().failed;
  const paths = resolvePaths(home);
  const cached = deps.credentialsFile === paths.credentialsFile;
  const commitCredentials = cached ? migrateCachedCredentials(paths) : undefined;
  const script = deps.shellScriptPath ?? join(deps.companyRoot, SCRIPT);
  if (!existsSync(script)) {
    reporter.item(
      deps.shellScriptPath ?? SCRIPT,
      "failed",
      deps.shellScriptPath === undefined
        ? "not found under the company repository — run npm install, then run this command again"
        : "The selected runtime shell script does not exist. Reinstall the pinned runtime.",
    );
  }
  for (const { file, shell, createIfMissing } of shellRcTargets(home, deps.env)) {
    const target = join(home, file);
    try {
      if (!existsSync(target) && !createIfMissing) {
        reporter.item(file, "skipped", `file does not exist, and this machine does not use ${shell}`);
        continue;
      }
      const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
      const result = renderManagedBlock(
        existing,
        shellBlock(deps.companyRoot, deps.shellScriptPath, deps.credentialsFile),
        "hash",
      );
      if (!result.changed) {
        reporter.item(file, "ok", "already ok");
        continue;
      }
      backups?.backup(target);
      writeFileSync(target, result.next);
      reporter.item(file, "updated", "synced — open a new terminal to load .env.credentials");
    } catch (error) {
      reporter.item(file, "failed", error instanceof Error ? error.message : String(error));
    }
  }
  if (cached && reporter.counts().failed === failuresBefore) {
    recordCachedShellReady(paths, deps.companyRoot);
    commitCredentials?.();
  }
  return reporter.failed() ? 1 : 0;
}
