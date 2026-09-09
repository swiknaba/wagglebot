import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BackupSet } from "../backup";
import { startBackupSet } from "../backup";
import type { Harness, McpTarget } from "../harness";
import { MARKERS, removeManagedBlock, renderManagedBlock } from "../managed-block";
import { hasJsonComments, mergeManagedSection } from "../managed-json";
import { envVarNames, renderEntry, renderTomlTables } from "../mcp-dialects";
import { resolvePaths } from "../paths";
import type { ProxyConfig } from "../registry";
import type { Reporter } from "../report";
import type { ManagedState } from "../state";
import { loadState, saveState } from "../state";

// The Claude Code renderer moved to mcp-dialects.ts, next to the other five. It stays exported
// here, because this module is where a caller looks for the entry the writer produces.
export { proxyToClaudeEntry } from "../mcp-dialects";

type JsonTarget = Extract<McpTarget, { format: "json" }>;
type TomlTarget = Extract<McpTarget, { format: "toml" }>;
type Entry = { namespace: string; entry: Record<string, unknown> };

// A TOML file has no key ownership, so the hash block of managed-block.ts is what wagglebot
// owns inside it.
const { begin: TOML_BLOCK_BEGIN, end: TOML_BLOCK_END } = MARKERS.hash;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The file text without the managed block, so a table wagglebot wrote never counts as foreign.
const outsideBlock = (text: string): string => {
  const begin = text.indexOf(TOML_BLOCK_BEGIN);
  const end = text.indexOf(TOML_BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) return text;
  return text.slice(0, begin) + text.slice(end + TOML_BLOCK_END.length);
};

// True when the text declares [<table>.<namespace>] itself. TOML accepts a bare key, a
// double-quoted key, and a single-quoted key, so all three count as a conflict.
const definesTable = (text: string, table: string, namespace: string): boolean => {
  const key = escapeRegExp(namespace);
  return new RegExp(`^\\s*\\[${escapeRegExp(table)}\\.(?:${key}|"${key}"|'${key}')\\]`, "m").test(text);
};

// Every ${VAR} the written config will expand. Missing ones are reported, never guessed.
export function missingEnvVars(proxies: ProxyConfig[], env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>();
  for (const p of proxies) for (const name of envVarNames(p)) names.add(name);
  return [...names].filter((n) => env[n] === undefined || env[n] === "").sort();
}

function writeJsonTarget(deps: {
  target: JsonTarget;
  path: string;
  rendered: Entry[];
  emptyReason: string;
  reporter: Reporter;
  backups: BackupSet;
  state: ManagedState;
  managedFile: string;
}): void {
  const { target, path, reporter, state } = deps;
  const entries = Object.fromEntries(deps.rendered.map((r) => [r.namespace, r.entry]));
  const prefix = `${target.parentKey}/`;
  const previouslyOwned = (state.jsonKeys[path] ?? [])
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
  if (Object.keys(entries).length === 0 && previouslyOwned.length === 0) {
    reporter.item(target.path, "skipped", deps.emptyReason);
    return;
  }
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  // Gemini CLI accepts comments in settings.json. A rewrite prints strict JSON and would drop
  // them, so the honest outcome is a skip with the reason (F22).
  if (existing !== "" && hasJsonComments(existing)) {
    reporter.item(
      target.path,
      "skipped",
      "the file contains comments, which a rewrite would lose — remove them, or add the MCP servers by hand",
    );
    return;
  }
  const result = mergeManagedSection(existing, target.parentKey, entries, previouslyOwned);
  if (!result.changed) {
    reporter.item(target.path, "ok", "already ok");
    return;
  }
  deps.backups.backup(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.next);
  state.jsonKeys[path] = [
    ...(state.jsonKeys[path] ?? []).filter((k) => !k.startsWith(prefix)),
    ...result.ownedNow.map((k) => `${prefix}${k}`),
  ];
  saveState(deps.managedFile, state);
  reporter.item(target.path, "updated", `${result.ownedNow.length} managed entries`);
}

// The TOML target keeps the servers of the engineer. A namespace the file already declares
// outside the block is a conflict: wagglebot reports it and writes no table for it.
function writeTomlTarget(deps: {
  harness: Harness;
  target: TomlTarget;
  path: string;
  rendered: Entry[];
  emptyReason: string;
  reporter: Reporter;
  backups: BackupSet;
}): void {
  const { harness, target, path, reporter } = deps;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const foreign = outsideBlock(existing);
  const kept = deps.rendered.filter(({ namespace }) => {
    if (!definesTable(foreign, target.table, namespace)) return true;
    reporter.item(
      `${namespace} (${harness.name})`,
      "failed",
      `already defined outside the wagglebot block in ${target.path} — remove it there, or rename the registry entry`,
    );
    return false;
  });
  if (kept.length === 0 && !existing.includes(TOML_BLOCK_BEGIN)) {
    reporter.item(target.path, "skipped", deps.emptyReason);
    return;
  }
  const result =
    kept.length === 0
      ? removeManagedBlock(existing, "hash")
      : renderManagedBlock(existing, renderTomlTables(target.table, kept), "hash");
  if (!result.changed) {
    reporter.item(target.path, "ok", "already ok");
    return;
  }
  // No chmod: the file belongs to the harness, and the block carries no secret.
  deps.backups.backup(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.next);
  reporter.item(target.path, "updated", `${kept.length} managed entries`);
}

export function runWriteMcp(deps: {
  home: string;
  harnesses: Harness[];
  proxies: ProxyConfig[];
  env: NodeJS.ProcessEnv;
  reporter: Reporter;
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

  // A file credential source needs the Phase 2 hub. Report it once, then leave it out of every config.
  const usable = proxies.filter((p) => !(p.auth !== undefined && p.auth.source.from === "file"));
  for (const p of proxies.filter((x) => !usable.includes(x))) {
    reporter.item(p.namespace, "skipped", "file credential source arrives with the Phase 2 hub");
  }

  for (const harness of deps.harnesses) {
    const mcpTarget = harness.mcpTarget;
    if (mcpTarget === undefined) continue;
    try {
      const path = join(home, mcpTarget.path);
      const rendered: Entry[] = [];
      for (const p of usable) {
        const result = renderEntry(mcpTarget.dialect, p);
        if (result.ok) rendered.push({ namespace: p.namespace, entry: result.entry });
        else reporter.item(`${p.namespace} (${harness.name})`, "skipped", result.reason);
      }
      // The registry can be empty, or every entry can be one this harness cannot express. The
      // second case must not read as an empty registry, because the skip lines say otherwise.
      const emptyReason =
        usable.length === 0
          ? "no MCP servers in the registry — file not created"
          : "no MCP server can be written for this harness — every entry was skipped above — file not created";
      if (mcpTarget.format === "toml") {
        writeTomlTarget({ harness, target: mcpTarget, path, rendered, emptyReason, reporter, backups });
      } else {
        writeJsonTarget({
          target: mcpTarget,
          path,
          rendered,
          emptyReason,
          reporter,
          backups,
          state,
          managedFile: paths.managedFile,
        });
      }
    } catch (error) {
      reporter.item(mcpTarget.path, "failed", error instanceof Error ? error.message : String(error));
    }
  }
  return reporter.failed() ? 1 : 0;
}
