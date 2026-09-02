import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackupSet } from "../backup";
import { startBackupSet } from "../backup";
import { HARNESSES } from "../harness";
import { mergeManagedSection } from "../managed-json";
import { resolvePaths } from "../paths";
import type { AuthScheme, CredentialSource, ProxyConfig } from "../registry";
import type { Reporter } from "../report";
import { loadState, saveState } from "../state";

const expansion = (source: CredentialSource): string | undefined =>
  source.from === "env" ? `\${${source.var}}` : undefined;

const headersFor = (scheme: AuthScheme, source: CredentialSource): Record<string, string> | undefined => {
  const value = expansion(source);
  if (value === undefined) return undefined;
  if (scheme.kind === "bearer") return { Authorization: `Bearer ${value}` };
  if (scheme.kind === "header") return { [scheme.name]: `${scheme.prefix ?? ""}${value}` };
  if (scheme.kind === "basic") return { Authorization: `Basic ${value}` };
  return undefined;
};

export function proxyToClaudeEntry(p: ProxyConfig): Record<string, unknown> {
  if (p.mode === "remote_http" || p.mode === "remote_sse") {
    const headers = p.auth === undefined ? undefined : headersFor(p.auth.scheme, p.auth.source);
    return {
      type: p.mode === "remote_http" ? "http" : "sse",
      url: p.endpoint,
      ...(headers === undefined ? {} : { headers }),
    };
  }
  const authEnv: Record<string, string> = {};
  if (p.auth !== undefined && p.auth.scheme.kind === "env") {
    const value = expansion(p.auth.source);
    if (value !== undefined) for (const key of Object.keys(p.auth.scheme.map)) authEnv[key] = value;
  }
  const env = { ...(p.env ?? {}), ...authEnv };
  const withEnv = Object.keys(env).length === 0 ? {} : { env };
  if (p.mode === "stdio_npx") return { command: "npx", args: ["-y", p.command ?? "", ...(p.args ?? [])], ...withEnv };
  return { command: p.command ?? "", args: p.args ?? [], ...withEnv };
}

export function runWriteMcp(deps: {
  home: string;
  proxies: ProxyConfig[];
  reporter: Reporter;
  dryRun?: boolean;
  backups?: BackupSet;
}): number {
  const { home, proxies, reporter } = deps;
  const paths = resolvePaths(home);
  const state = loadState(paths.managedFile);
  const backups = deps.backups ?? startBackupSet(paths.backupsDir);
  reporter.section("MCP configs");

  for (const harness of HARNESSES) {
    const mcpTarget = harness.mcpTarget;
    if (mcpTarget === undefined) {
      reporter.item(harness.name, "skipped", "no MCP config adapter in Phase 1 (R2)");
      continue;
    }
    try {
      const target = join(home, mcpTarget.path);
      const usable = proxies.filter((p) => !(p.auth !== undefined && p.auth.source.from === "file"));
      for (const p of proxies.filter((x) => !usable.includes(x))) {
        reporter.item(p.namespace, "skipped", "file credential source arrives with the Phase 2 hub");
      }
      const entries = Object.fromEntries(usable.map((p) => [p.namespace, proxyToClaudeEntry(p)]));
      const prefix = `${mcpTarget.parentKey}/`;
      const previouslyOwned = (state.jsonKeys[target] ?? [])
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
      const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
      const result = mergeManagedSection(existing, mcpTarget.parentKey, entries, previouslyOwned);
      if (!result.changed) {
        reporter.item(mcpTarget.path, "ok", "already ok");
        continue;
      }
      if (deps.dryRun === true) {
        reporter.item(mcpTarget.path, "skipped", "would write (dry run)");
        continue;
      }
      backups.backup(target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, result.next);
      state.jsonKeys[target] = [
        ...(state.jsonKeys[target] ?? []).filter((k) => !k.startsWith(prefix)),
        ...result.ownedNow.map((k) => `${prefix}${k}`),
      ];
      saveState(paths.managedFile, state);
      reporter.item(mcpTarget.path, "updated", `${result.ownedNow.length} managed entries`);
    } catch (error) {
      reporter.item(mcpTarget.path, "failed", error instanceof Error ? error.message : String(error));
    }
  }
  return reporter.failed() ? 1 : 0;
}
