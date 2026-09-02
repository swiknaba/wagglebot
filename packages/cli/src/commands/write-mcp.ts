import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackupSet } from "../backup";
import { startBackupSet } from "../backup";
import type { Harness } from "../harness";
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

// Every ${VAR} the written config will expand. Missing ones are reported, never guessed.
export function missingEnvVars(proxies: ProxyConfig[], env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>();
  for (const p of proxies) {
    if (p.auth?.source.from === "env") names.add(p.auth.source.var);
    for (const value of Object.values(p.env ?? {})) {
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      if (m?.[1] !== undefined) names.add(m[1]);
    }
  }
  return [...names].filter((n) => env[n] === undefined || env[n] === "").sort();
}

export function runWriteMcp(deps: {
  home: string;
  harnesses: Harness[];
  proxies: ProxyConfig[];
  env: NodeJS.ProcessEnv;
  reporter: Reporter;
  dryRun?: boolean;
  backups?: BackupSet;
}): number {
  const { home, proxies, reporter } = deps;
  const paths = resolvePaths(home);
  const state = loadState(paths.managedFile);
  const backups = deps.backups ?? startBackupSet(paths.backupsDir);
  reporter.section("MCP configs");

  for (const name of missingEnvVars(proxies, deps.env)) {
    reporter.item(name, "skipped", "not set in this shell — add it to .env.credentials, then open a new terminal");
  }

  const without = deps.harnesses.filter((h) => h.mcpTarget === undefined).map((h) => h.name);
  if (without.length > 0) {
    reporter.item("mcp", "skipped", `no MCP config adapter: ${without.join(", ")}`);
  }

  for (const harness of deps.harnesses) {
    const mcpTarget = harness.mcpTarget;
    if (mcpTarget === undefined) continue;
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
      if (Object.keys(entries).length === 0 && previouslyOwned.length === 0) {
        reporter.item(mcpTarget.path, "skipped", "no MCP servers in the registry — file not created");
        continue;
      }
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
