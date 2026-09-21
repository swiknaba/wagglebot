import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { BackupSet } from "../backup";
import { startBackupSet } from "../backup";
import type { Harness, McpTarget } from "../harness";
import { MARKERS, removeManagedBlock, renderManagedBlock } from "../managed-block";
import { hasJsonComments, mergeManagedSection, replaceJsonCategory } from "../managed-json";
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

// Remove category tables without a TOML rewrite. Quotes and arrays can contain text that resembles a table.
function removeTomlCategory(text: string, table: string): string {
  try {
    parseToml(text);
  } catch {
    throw new Error("The file contains invalid TOML. The writer did not change the file.");
  }
  const key = String.raw`(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')`;
  const header = new RegExp(`^\\s*\\[\\[?\\s*(${key})(?:\\s*\\.\\s*${key})*\\s*\\]\\]?\\s*(?:#.*)?$`);
  const assignment = new RegExp(`^\\s*(${key})(?:\\s*\\.\\s*${key})*\\s*=`);
  const keyName = (root: string): string => {
    if (root.startsWith("'")) return root.slice(1, -1);
    if (!root.startsWith('"')) return root;
    // TOML also accepts eight-digit Unicode escapes in basic keys.
    const jsonKey = root.replace(/\\(?:U([0-9a-fA-F]{8})|.)/g, (escaped, code: string | undefined) =>
      code === undefined ? escaped : JSON.stringify(String.fromCodePoint(Number.parseInt(code, 16))).slice(1, -1),
    );
    return JSON.parse(jsonKey);
  };
  let quote = "";
  let multiline = false;
  let depth = 0;
  let discard = false;
  let discardValue = false;
  let atRoot = true;
  const kept: string[] = [];
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (quote === "" && depth === 0) {
      const assignedRoot = atRoot ? assignment.exec(line)?.[1] : undefined;
      discardValue = assignedRoot !== undefined && keyName(assignedRoot) === table;
    }
    if (quote === "" && depth === 0 && [TOML_BLOCK_BEGIN, TOML_BLOCK_END].includes(line.trim())) continue;
    const root = quote === "" && depth === 0 ? header.exec(line.trimEnd())?.[1] : undefined;
    if (root !== undefined) {
      atRoot = false;
      discard = keyName(root) === table;
    } else {
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (quote !== "") {
          if (quote === '"' && char === "\\") i += 1;
          else if (multiline && line.startsWith(quote.repeat(3), i)) {
            while (line[i + 1] === quote) i += 1;
            quote = "";
            multiline = false;
          } else if (!multiline && char === quote) quote = "";
        } else if (char === "#") break;
        else if (char === '"' || char === "'") {
          quote = char;
          multiline = line.startsWith(char.repeat(3), i);
          if (multiline) i += 2;
        } else if (char === "[" || char === "{") depth += 1;
        else if (char === "]" || char === "}") depth -= 1;
      }
    }
    if (!discard && !discardValue) kept.push(line);
  }
  if (quote !== "" || depth !== 0)
    throw new Error("The TOML contains an incomplete string or array. The writer did not change the file.");
  return kept.join("");
}

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
  overwrite: boolean;
}): void {
  const { target, path, reporter, state } = deps;
  const entries = Object.fromEntries(deps.rendered.map((r) => [r.namespace, r.entry]));
  const prefix = `${target.parentKey}/`;
  const previouslyOwned = (state.jsonKeys[path] ?? [])
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
  if (Object.keys(entries).length === 0 && previouslyOwned.length === 0 && !(deps.overwrite && existsSync(path))) {
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
  const result = deps.overwrite
    ? { ...replaceJsonCategory(existing, target.parentKey, entries), ownedNow: Object.keys(entries) }
    : mergeManagedSection(existing, target.parentKey, entries, previouslyOwned);
  commitTarget({
    path,
    label: target.path,
    result,
    detail: `${result.ownedNow.length} managed entries`,
    reporter,
    backups: deps.backups,
    overwrite: deps.overwrite,
  });
  state.jsonKeys[path] = [
    ...(state.jsonKeys[path] ?? []).filter((k) => !k.startsWith(prefix)),
    ...result.ownedNow.map((k) => `${prefix}${k}`),
  ];
  saveState(deps.managedFile, state);
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
  overwrite: boolean;
}): void {
  const { harness, target, path, reporter } = deps;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const foreign = outsideBlock(existing);
  const kept = deps.rendered.filter(({ namespace }) => {
    if (deps.overwrite) return true;
    if (!definesTable(foreign, target.table, namespace)) return true;
    reporter.item(
      `${namespace} (${harness.name})`,
      "failed",
      `already defined outside the wagglebot block in ${target.path} — remove it there, or rename the registry entry`,
    );
    return false;
  });
  if (kept.length === 0 && !existing.includes(TOML_BLOCK_BEGIN) && !deps.overwrite) {
    // A conflict already produced its failed line. Only an entry that no dialect rendered needs
    // the extra explanation.
    if (deps.rendered.length === 0) reporter.item(target.path, "skipped", deps.emptyReason);
    return;
  }
  const content = renderTomlTables(target.table, kept);
  let next: string;
  if (deps.overwrite) {
    const base = removeTomlCategory(existing, target.table);
    const separator = base === "" || base.endsWith("\n") ? "" : "\n\n";
    next = kept.length === 0 ? base : `${base}${separator}${renderManagedBlock("", content, "hash").next}`;
  } else {
    next = (kept.length === 0 ? removeManagedBlock(existing, "hash") : renderManagedBlock(existing, content, "hash"))
      .next;
  }
  const result = { next, changed: next !== existing };
  // No chmod: the file belongs to the harness, and the block carries no secret.
  commitTarget({
    path,
    label: target.path,
    result,
    detail: `${kept.length} managed entries`,
    reporter,
    backups: deps.backups,
    overwrite: deps.overwrite,
  });
}

// Writes one target when its content changed, after a backup, and reports the outcome. Returns
// true when the file was written.
function commitTarget(deps: {
  path: string;
  label: string;
  result: { next: string; changed: boolean };
  detail: string;
  reporter: Reporter;
  backups: BackupSet;
  overwrite: boolean;
}): boolean {
  if (!deps.result.changed) {
    deps.reporter.item(deps.label, "ok", "already ok");
    return false;
  }
  if (!deps.overwrite) deps.backups.backup(deps.path);
  mkdirSync(dirname(deps.path), { recursive: true });
  writeFileSync(deps.path, deps.result.next);
  deps.reporter.item(deps.label, "updated", deps.detail);
  return true;
}

export function runWriteMcp(deps: {
  home: string;
  harnesses: Harness[];
  proxies: ProxyConfig[];
  env: NodeJS.ProcessEnv;
  reporter: Reporter;
  backups?: BackupSet;
  overwrite?: boolean;
}): number {
  const { home, proxies, reporter } = deps;
  const paths = resolvePaths(home);
  const state = loadState(paths.managedFile);
  const backups = deps.backups ?? startBackupSet(paths.backupsDir);
  reporter.section("MCP configs");

  for (const name of missingEnvVars(proxies, deps.env)) {
    reporter.item(name, "skipped", "not set in this shell — add it to .env.credentials, then open a new terminal");
  }

  const without = deps.harnesses.filter((h) => h.mcpTargets.length === 0).map((h) => h.name);
  if (without.length > 0) {
    reporter.item("mcp", "skipped", `no MCP config adapter: ${without.join(", ")}`);
  }

  // A file credential source needs the Phase 2 hub. Report it once, then leave it out of every config.
  const usable = proxies.filter((p) => !(p.auth !== undefined && p.auth.source.from === "file"));
  for (const p of proxies.filter((x) => !usable.includes(x))) {
    reporter.item(p.namespace, "skipped", "file credential source arrives with the Phase 2 hub");
  }

  for (const harness of deps.harnesses) {
    for (const mcpTarget of harness.mcpTargets) {
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
          writeTomlTarget({
            harness,
            target: mcpTarget,
            path,
            rendered,
            emptyReason,
            reporter,
            backups,
            overwrite: deps.overwrite ?? false,
          });
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
            overwrite: deps.overwrite ?? false,
          });
        }
      } catch (error) {
        reporter.item(mcpTarget.path, "failed", error instanceof Error ? error.message : String(error));
      }
    }
  }
  return reporter.failed() ? 1 : 0;
}
