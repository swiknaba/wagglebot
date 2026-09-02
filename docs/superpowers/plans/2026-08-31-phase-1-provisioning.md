# Phase 1 — Provisioning CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the repository boilerplate and the complete Phase 1 `wagglebot` CLI: `update`, `init`, `install-skills`, `install-agents`, `sync-agents`, and the MCP config writer.

**Architecture:** One npm package, `packages/cli`. TypeScript source, tested with `bun test`, bundled to one Node-compatible file with `bun build --target=node`. Every harness mutation goes through two shared writers: a Markdown managed block, and a per-key JSON section tracked in `~/.wagglebot/managed.json`. Commands are pure functions that take injected dependencies (exec, home dir, reporter), so tests never touch the real home directory or the network.

**Tech Stack:** TypeScript (strict, ES2022), Bun (workspaces, test runner, bundler), Biome, `yaml` (bundled), `node:util` `parseArgs`. The published artifact runs under Node >= 20, so source uses `node:*` APIs only, never `Bun.*` APIs.

**Spec:** `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md` (primary), with `docs/superpowers/specs/2026-08-28-wagglebot-design.md` (decisions D10, D13, D20, D27, D29, D31–D35) and `docs/superpowers/specs/2026-08-28-service-contracts.md` (§C1 conventions, §C2 `ProxyConfig`, catalog format).

## Global Constraints

Copied from the specs. Every task's requirements include this section.

- "Bun workspaces, Biome (2-space, line width 120), strict TS (ES2022, bundler resolution), colocated `*.test.ts`, `bun test`." (§C1)
- "avoid `try/catch` where possible. Do not use `as` casts or `@ts-ignore`. Prefer functional array methods." (§C1). Exception to "Prefer Bun APIs": the CLI must run under Node >= 20 on engineer workstations, so CLI source uses `node:*` APIs.
- "Config module pattern: a defaults object, and typed coercers that throw descriptive errors." Dependencies are injected parameters so tests can inject them. (§C1)
- "**Idempotent.** A second run changes nothing and says so." (phase 1 spec)
- "**Non-destructive.** Every harness file is written inside a managed block. Content outside the block stays untouched (F22)."
- "The template sync never writes a secret (guards F23)." No command ever writes a credential value.
- "**Every executable dependency is pinned.**" (D13) — exact dependency versions, GitHub Actions pinned by commit SHA.
- "Wagglebot never picks a winner silently (P35)." — unknown catalog values and unmatched usernames are hard errors that name the file and the value.
- Managed block markers for Markdown: `<!-- wagglebot:begin -->` … `<!-- wagglebot:end -->`. JSON ownership state: `~/.wagglebot/managed.json`. Backups: `~/.wagglebot/backups/<timestamp>/`.
- All prose written in this work (README, --help, templates) follows the STE baseline in the user instructions.

## File Structure

```
(root)
├── package.json                     # private workspace root
├── biome.json
├── tsconfig.json
├── .gitignore
├── .github/workflows/ci.yml        # NEW: lint, typecheck, test, audit, build smoke
└── packages/cli/
    ├── package.json                 # MODIFIED: build script, deps, files list
    ├── bin/wagglebot.js             # MODIFIED: thin loader for dist/index.js
    ├── src/
    │   ├── index.ts                 # arg dispatch + --help
    │   ├── report.ts                # Reporter: sections, counters, summary
    │   ├── paths.ts                 # ~/.wagglebot locations
    │   ├── state.ts                 # managed.json load/save
    │   ├── backup.ts                # backup sets + restore
    │   ├── managed-block.ts         # Markdown managed block writer
    │   ├── managed-json.ts          # per-key JSON writer + hooks merge
    │   ├── lists.ts                 # skills.list / agents.*.list parser
    │   ├── catalog.ts               # Backstage YAML loader + validation
    │   ├── identity.ts              # wagglebot.username git config flow
    │   ├── registry.ts              # registry loader, validation, merge
    │   ├── harness.ts               # the harness target table
    │   ├── template.ts              # base + overlays concatenation
    │   ├── exec.ts                  # Exec type + real implementation
    │   ├── company.ts               # company repo root + file loading
    │   └── commands/
    │       ├── sync-agents.ts
    │       ├── write-mcp.ts
    │       ├── install-skills.ts
    │       ├── install-agents.ts
    │       ├── update.ts
    │       └── init.ts
    └── templates/
        ├── AGENTS.base.md           # seed content from the phase 1 spec
        ├── hooks/claude-code.json
        └── init/                    # the `wagglebot init` scaffold
```

Each `src/x.ts` has a colocated `src/x.test.ts`.

## Cross-Task Decisions

Executors read these once. Each records a spec-driven choice that several tasks share.

1. **Node runtime, Bun toolchain.** Engineers run the CLI through `yarn` + Node (D34). Source imports `node:*` modules only. `bun build --target=node` bundles `src/index.ts` plus the `yaml` package into `dist/index.js`.
2. **`stdio_npx` carries the package in `command`.** `ProxyConfig.command` holds the pinned package spec (for example `@example/mcp@1.4.2`). Validation rejects a missing exact version (P31).
3. **Credentials appear only as `${VAR}` expansion strings** in written MCP configs. A `literal` credential source is a hard error in Phase 1, because every registry file is shared (§C2 rule 4).
4. **Unpinned list entries warn, never block.** The tool cannot know which repositories are first-party, so the pull request review enforces D32. The parser emits one warning per unpinned entry.
5. **Phase 1 harness adapters.** Base template: all six harnesses from the spec table. Hooks: Claude Code only (`~/.claude/settings.json`). MCP config: Claude Code only (`~/.claude.json`, key `mcpServers`). Subagents: Claude Code only (`~/.claude/agents/`). Every unsupported harness/feature pair logs one `skipped` line (research list R2).
6. **Hook ownership marker.** Every hook entry this tool writes contains the substring `wagglebot:` inside its command string. The merge owns exactly the array elements that carry the marker.
7. **Tests never touch the real home directory.** Every command takes `home: string` and writes under a `fs.mkdtempSync` directory in tests.

---

### Task 1: Workspace Boilerplate, Build, and CI

**Files:**
- Create: `package.json` (root), `biome.json`, `tsconfig.json`, `.gitignore`, `.github/workflows/ci.yml`, `packages/cli/src/index.ts`, `packages/cli/src/index.test.ts`
- Modify: `packages/cli/package.json`, `packages/cli/bin/wagglebot.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `main(argv: string[], deps?: Partial<Deps>): Promise<number>` in `src/index.ts` (later tasks extend its dispatch table); the `bun run --cwd packages/cli build` script; passing `bun test`.

- [ ] **Step 1: Write the root workspace files**

`package.json` (root):

```json
{
  "name": "wagglebot-monorepo",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "check": "biome check .",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "build": "bun run --cwd packages/cli build"
  },
  "devDependencies": {
    "@biomejs/biome": "2.2.0",
    "@types/bun": "1.2.21",
    "@types/node": "24.3.0",
    "typescript": "5.9.2"
  }
}
```

`biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.2.0/schema.json",
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 120 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "files": { "includes": ["packages/**", "*.json"] }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["packages/**/*.ts"]
}
```

`.gitignore`:

```
node_modules/
dist/
```

- [ ] **Step 2: Rewrite the CLI package manifest and entry**

`packages/cli/package.json` — keep name, version `0.0.1`, license, repository, homepage, keywords, engines; replace the rest:

```json
{
  "name": "wagglebot",
  "version": "0.0.1",
  "description": "One AI agent setup for a whole engineering team.",
  "license": "MIT",
  "type": "module",
  "repository": { "type": "git", "url": "git+https://github.com/swiknaba/wagglebot.git" },
  "homepage": "https://github.com/swiknaba/wagglebot#readme",
  "bin": { "wagglebot": "bin/wagglebot.js" },
  "files": ["bin/", "dist/", "templates/", "README.md"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "bun build src/index.ts --target=node --outdir dist"
  },
  "devDependencies": { "yaml": "2.8.0" },
  "keywords": ["ai", "agents", "mcp", "provisioning", "skills"]
}
```

`packages/cli/bin/wagglebot.js`:

```js
#!/usr/bin/env node
import { main } from "../dist/index.js";
process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 3: Write the failing test for `main`**

`packages/cli/src/index.test.ts`:

```ts
import { expect, test } from "bun:test";
import { main } from "./index";

test("--version prints the package version and exits 0", async () => {
  const lines: string[] = [];
  const code = await main(["--version"], { write: (l) => lines.push(l) });
  expect(code).toBe(0);
  expect(lines[0]).toMatch(/^\d+\.\d+\.\d+$/);
});

test("an unknown command exits 2 and names the command", async () => {
  const lines: string[] = [];
  const code = await main(["bogus"], { write: (l) => lines.push(l) });
  expect(code).toBe(2);
  expect(lines.join("\n")).toContain("bogus");
});
```

Run: `bun install && bun test packages/cli/src/index.test.ts` — expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/index.ts` minimally**

```ts
import { createRequire } from "node:module";

export type CliDeps = { write: (line: string) => void };

const version = (): string => {
  const require = createRequire(import.meta.url);
  const pkg: { version: string } = require("../package.json");
  return pkg.version;
};

export async function main(argv: string[], deps: CliDeps = { write: console.log }): Promise<number> {
  const [command] = argv;
  if (command === "--version" || command === "-v") {
    deps.write(version());
    return 0;
  }
  deps.write(`wagglebot: unknown command "${command ?? ""}". Run: wagglebot --help`);
  return 2;
}
```

Run: `bun test packages/cli/src/index.test.ts` — expected: PASS. Then verify the toolchain: `bun run check && bun run typecheck && bun run build && node packages/cli/bin/wagglebot.js --version` — expected: prints `0.0.1`.

- [ ] **Step 5: Add CI and commit**

`.github/workflows/ci.yml` — resolve each action SHA first (for example `gh api repos/oven-sh/setup-bun/commits/v2 --jq .sha`) and pin it (D13):

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  checks:
    if: "!contains(github.event.head_commit.message, '[skip ci]')"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha> # v4
      - uses: oven-sh/setup-bun@<pinned-sha> # v2
      - run: bun install --frozen-lockfile
      - run: bun run check
      - run: bun run typecheck
      - run: bun test
      - run: bun audit --audit-level high
      - run: bun run build
      - uses: actions/setup-node@<pinned-sha> # v4
        with: { node-version: 20 }
      - run: node packages/cli/bin/wagglebot.js --version
  osv:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha> # v4
      - uses: google/osv-scanner-action/osv-scanner-action@<pinned-sha> # pinned release
        with: { scan-args: "--lockfile=bun.lock" }
```

`<pinned-sha>` is not a placeholder to leave in the file: the implementer resolves each real SHA with the `gh api` command above before committing.

```bash
git add package.json biome.json tsconfig.json .gitignore .github/workflows/ci.yml packages/cli
git commit -m "chore: workspace boilerplate, CLI build pipeline, CI checks"
```

---

### Task 2: Reporter

**Files:**
- Create: `packages/cli/src/report.ts`
- Test: `packages/cli/src/report.test.ts`

**Interfaces:**
- Produces:

```ts
export type ItemStatus = "installed" | "updated" | "ok" | "failed" | "skipped";
export type Reporter = {
  section(title: string): void;
  item(name: string, status: ItemStatus, detail?: string): void;
  counts(): Record<ItemStatus, number>;
  failed(): boolean;
  summary(): string; // "installed 2, updated 1, ok 4, skipped 1, failed 0"
};
export function createReporter(write: (line: string) => void, color?: boolean): Reporter;
```

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createReporter } from "./report";

test("counts items and reports failure", () => {
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  r.section("Skills");
  r.item("obra/superpowers", "installed");
  r.item("x/y", "failed", "clone failed");
  expect(r.counts().installed).toBe(1);
  expect(r.failed()).toBe(true);
  expect(r.summary()).toBe("installed 1, updated 0, ok 0, skipped 0, failed 1");
  expect(lines).toContain("== Skills ==");
  expect(lines.some((l) => l.includes("x/y") && l.includes("clone failed"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/report.test.ts` — expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
export type ItemStatus = "installed" | "updated" | "ok" | "skipped" | "failed";
export type Reporter = {
  section(title: string): void;
  item(name: string, status: ItemStatus, detail?: string): void;
  counts(): Record<ItemStatus, number>;
  failed(): boolean;
  summary(): string;
};

const COLORS: Record<ItemStatus, string> = {
  installed: "[32m",
  updated: "[36m",
  ok: "[90m",
  skipped: "[33m",
  failed: "[31m",
};
const RESET = "[0m";
const ORDER: ItemStatus[] = ["installed", "updated", "ok", "skipped", "failed"];

export function createReporter(write: (line: string) => void, color = process.stdout.isTTY === true): Reporter {
  const tally: Record<ItemStatus, number> = { installed: 0, updated: 0, ok: 0, skipped: 0, failed: 0 };
  return {
    section: (title) => write(`== ${title} ==`),
    item: (name, status, detail) => {
      tally[status] += 1;
      const label = color ? `${COLORS[status]}${status}${RESET}` : status;
      write(`  ${label.padEnd(color ? 18 : 9)} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
    },
    counts: () => ({ ...tally }),
    failed: () => tally.failed > 0,
    summary: () => ORDER.map((s) => `${s} ${tally[s]}`).join(", "),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/report.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/report.ts packages/cli/src/report.test.ts
git commit -m "feat(cli): reporter with sections, counters, and summary"
```

---

### Task 3: Paths and Managed State

**Files:**
- Create: `packages/cli/src/paths.ts`, `packages/cli/src/state.ts`
- Test: `packages/cli/src/paths.test.ts`, `packages/cli/src/state.test.ts`

**Interfaces:**
- Produces:

```ts
// paths.ts
export type WagglePaths = {
  stateDir: string;      // <home>/.wagglebot
  managedFile: string;   // <home>/.wagglebot/managed.json
  backupsDir: string;    // <home>/.wagglebot/backups
  agentsCacheDir: string; // <home>/.wagglebot/agents-cache
};
export function resolvePaths(home: string): WagglePaths;

// state.ts
export type ManagedState = {
  jsonKeys: Record<string, string[]>; // target file path -> owned child keys per parent, "parentKey/childKey"
  agentFiles: string[];               // absolute paths of installed subagent files
};
export function loadState(managedFile: string): ManagedState; // missing file -> empty state
export function saveState(managedFile: string, state: ManagedState): void; // mkdir -p, atomic-ish write
```

- [ ] **Step 1: Write the failing tests**

```ts
// paths.test.ts
import { expect, test } from "bun:test";
import { resolvePaths } from "./paths";

test("resolves all state locations under <home>/.wagglebot", () => {
  const p = resolvePaths("/tmp/h");
  expect(p.stateDir).toBe("/tmp/h/.wagglebot");
  expect(p.managedFile).toBe("/tmp/h/.wagglebot/managed.json");
  expect(p.backupsDir).toBe("/tmp/h/.wagglebot/backups");
  expect(p.agentsCacheDir).toBe("/tmp/h/.wagglebot/agents-cache");
});
```

```ts
// state.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "./state";

test("missing file loads as empty state; save then load round-trips", () => {
  const file = join(mkdtempSync(join(tmpdir(), "wgl-")), "managed.json");
  expect(loadState(file)).toEqual({ jsonKeys: {}, agentFiles: [] });
  const state = { jsonKeys: { "/x/settings.json": ["mcpServers/example"] }, agentFiles: ["/x/a.md"] };
  saveState(file, state);
  expect(loadState(file)).toEqual(state);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/paths.test.ts packages/cli/src/state.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// paths.ts
import { join } from "node:path";
export type WagglePaths = { stateDir: string; managedFile: string; backupsDir: string; agentsCacheDir: string };
export function resolvePaths(home: string): WagglePaths {
  const stateDir = join(home, ".wagglebot");
  return {
    stateDir,
    managedFile: join(stateDir, "managed.json"),
    backupsDir: join(stateDir, "backups"),
    agentsCacheDir: join(stateDir, "agents-cache"),
  };
}
```

```ts
// state.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ManagedState = { jsonKeys: Record<string, string[]>; agentFiles: string[] };
const EMPTY: ManagedState = { jsonKeys: {}, agentFiles: [] };

export function loadState(managedFile: string): ManagedState {
  if (!existsSync(managedFile)) return { jsonKeys: {}, agentFiles: [] };
  const raw: unknown = JSON.parse(readFileSync(managedFile, "utf8"));
  if (typeof raw !== "object" || raw === null) return { ...EMPTY };
  const record = raw as Record<string, unknown>; // narrow via runtime checks below
  const jsonKeys = typeof record.jsonKeys === "object" && record.jsonKeys !== null ? (record.jsonKeys as Record<string, string[]>) : {};
  const agentFiles = Array.isArray(record.agentFiles) ? record.agentFiles.filter((f): f is string => typeof f === "string") : [];
  return { jsonKeys, agentFiles };
}

export function saveState(managedFile: string, state: ManagedState): void {
  mkdirSync(dirname(managedFile), { recursive: true });
  writeFileSync(managedFile, `${JSON.stringify(state, null, 2)}\n`);
}
```

NOTE: the two `as` narrowings above violate the letter of §C1. If Biome or review rejects them, replace with explicit per-field runtime validation functions. Do not use `@ts-ignore`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/paths.test.ts packages/cli/src/state.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/paths.ts packages/cli/src/paths.test.ts packages/cli/src/state.ts packages/cli/src/state.test.ts
git commit -m "feat(cli): wagglebot state paths and managed.json store"
```

---

### Task 4: Backups and Restore

**Files:**
- Create: `packages/cli/src/backup.ts`
- Test: `packages/cli/src/backup.test.ts`

**Interfaces:**
- Consumes: `WagglePaths` from Task 3.
- Produces:

```ts
export type BackupSet = { dir: string; backup(targetFile: string): void };
export function startBackupSet(backupsDir: string, now?: Date): BackupSet;
// Copies targetFile into <backupsDir>/<YYYYMMDD-HHmmss>/<encoded path>, once per file per set.
export function newestBackupSet(backupsDir: string): string | undefined;
export function restoreSet(setDir: string, onlyTarget?: string): string[]; // returns restored target paths
```

Path encoding: replace every `/` in the absolute target path with `%2F` for the backup file name; decode on restore.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestBackupSet, restoreSet, startBackupSet } from "./backup";

test("backs up before mutation, restores the newest set", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-"));
  const target = join(root, "CLAUDE.md");
  writeFileSync(target, "original");
  const set = startBackupSet(join(root, "backups"), new Date("2026-08-31T10:00:00Z"));
  set.backup(target);
  set.backup(target); // second call is a no-op
  writeFileSync(target, "mutated");
  const newest = newestBackupSet(join(root, "backups"));
  expect(newest).toBe(set.dir);
  const restored = restoreSet(set.dir);
  expect(restored).toEqual([target]);
  expect(readFileSync(target, "utf8")).toBe("original");
});

test("backup of a missing target is a no-op", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-"));
  const set = startBackupSet(join(root, "backups"));
  set.backup(join(root, "absent.md"));
  expect(restoreSet(set.dir)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/backup.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const stamp = (d: Date): string =>
  d.toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15);
const encode = (p: string): string => p.replaceAll("/", "%2F");
const decode = (name: string): string => name.replaceAll("%2F", "/");

export type BackupSet = { dir: string; backup(targetFile: string): void };

export function startBackupSet(backupsDir: string, now = new Date()): BackupSet {
  const dir = join(backupsDir, stamp(now));
  const done = new Set<string>();
  return {
    dir,
    backup(targetFile) {
      if (done.has(targetFile) || !existsSync(targetFile)) return;
      mkdirSync(dir, { recursive: true });
      copyFileSync(targetFile, join(dir, encode(targetFile)));
      done.add(targetFile);
    },
  };
}

export function newestBackupSet(backupsDir: string): string | undefined {
  if (!existsSync(backupsDir)) return undefined;
  const sets = readdirSync(backupsDir).toSorted();
  const last = sets.at(-1);
  return last === undefined ? undefined : join(backupsDir, last);
}

export function restoreSet(setDir: string, onlyTarget?: string): string[] {
  if (!existsSync(setDir)) return [];
  return readdirSync(setDir)
    .map(decode)
    .filter((target) => onlyTarget === undefined || target === onlyTarget)
    .map((target) => {
      copyFileSync(join(setDir, encode(target)), target);
      return target;
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/backup.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/backup.ts packages/cli/src/backup.test.ts
git commit -m "feat(cli): timestamped backup sets with restore"
```

---

### Task 5: Markdown Managed Block

**Files:**
- Create: `packages/cli/src/managed-block.ts`
- Test: `packages/cli/src/managed-block.test.ts`

**Interfaces:**
- Produces:

```ts
export const BLOCK_BEGIN = "<!-- wagglebot:begin -->";
export const BLOCK_END = "<!-- wagglebot:end -->";
export function renderManagedBlock(existing: string, content: string): { next: string; changed: boolean };
```

Behavior: when both markers exist, replace only the text between them. When no marker exists, append `\n<block>\n` to the existing text. A begin marker without an end marker (or reversed order) throws an `Error` that names the problem — never guess (P35).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { BLOCK_BEGIN, BLOCK_END, renderManagedBlock } from "./managed-block";

const block = (body: string) => `${BLOCK_BEGIN}\n${body}\n${BLOCK_END}`;

test("appends the block to a file with no markers", () => {
  const { next, changed } = renderManagedBlock("# Mine\n", "RULES v1");
  expect(changed).toBe(true);
  expect(next).toBe(`# Mine\n\n${block("RULES v1")}\n`);
});

test("replaces only the block and preserves surrounding content", () => {
  const existing = `# Mine\n\n${block("RULES v1")}\n\n## Also mine\n`;
  const { next, changed } = renderManagedBlock(existing, "RULES v2");
  expect(changed).toBe(true);
  expect(next).toBe(`# Mine\n\n${block("RULES v2")}\n\n## Also mine\n`);
});

test("is idempotent", () => {
  const existing = `intro\n\n${block("RULES v1")}\n`;
  expect(renderManagedBlock(existing, "RULES v1")).toEqual({ next: existing, changed: false });
});

test("a lone begin marker throws", () => {
  expect(() => renderManagedBlock(`${BLOCK_BEGIN}\nx`, "y")).toThrow("end marker");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/managed-block.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export const BLOCK_BEGIN = "<!-- wagglebot:begin -->";
export const BLOCK_END = "<!-- wagglebot:end -->";

export function renderManagedBlock(existing: string, content: string): { next: string; changed: boolean } {
  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  const rendered = `${BLOCK_BEGIN}\n${content}\n${BLOCK_END}`;
  if (begin === -1 && end === -1) {
    const sep = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { next: `${existing}${sep}${rendered}\n`, changed: true };
  }
  if (begin === -1) throw new Error("managed block: found the end marker without a begin marker");
  if (end === -1) throw new Error("managed block: found the begin marker without an end marker");
  if (end < begin) throw new Error("managed block: the end marker appears before the begin marker");
  const next = existing.slice(0, begin) + rendered + existing.slice(end + BLOCK_END.length);
  return { next, changed: next !== existing };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/managed-block.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/managed-block.ts packages/cli/src/managed-block.test.ts
git commit -m "feat(cli): non-destructive Markdown managed block writer"
```

---

### Task 6: Managed JSON Writer and Hooks Merge

**Files:**
- Create: `packages/cli/src/managed-json.ts`
- Test: `packages/cli/src/managed-json.test.ts`

**Interfaces:**
- Produces:

```ts
// Owns child entries under one parent key (for example parentKey = "mcpServers").
// previouslyOwned: child names owned from managed.json ("mcpServers/example" is stored;
// callers pass and receive bare child names — the caller adds the "parentKey/" prefix for state).
export function mergeManagedSection(
  existingText: string, // "" for a missing file
  parentKey: string,
  entries: Record<string, unknown>,
  previouslyOwned: string[],
): { next: string; changed: boolean; ownedNow: string[] };

// Merges hook fragment entries into a settings object. Owns only array elements whose
// command contains "wagglebot:". Never replaces foreign elements (F22).
export function mergeHooks(
  existingText: string,
  fragment: { hooks: Record<string, unknown[]> },
): { next: string; changed: boolean };
```

Both functions parse with `JSON.parse`, mutate a deep copy, and print with `JSON.stringify(obj, null, 2) + "\n"`. Invalid JSON in the existing file throws an `Error` naming the file content problem; the caller reports `failed` for that target.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { mergeHooks, mergeManagedSection } from "./managed-json";

test("writes owned entries, preserves foreign keys, removes stale owned entries", () => {
  const existing = JSON.stringify({ theme: "dark", mcpServers: { mine: { url: "http://x" }, old: { url: "y" } } });
  const r = mergeManagedSection(existing, "mcpServers", { example: { url: "https://e" } }, ["old"]);
  const doc = JSON.parse(r.next);
  expect(doc.theme).toBe("dark");
  expect(doc.mcpServers.mine).toEqual({ url: "http://x" }); // foreign, untouched
  expect(doc.mcpServers.old).toBeUndefined(); // stale owned, removed
  expect(doc.mcpServers.example).toEqual({ url: "https://e" });
  expect(r.ownedNow).toEqual(["example"]);
  expect(r.changed).toBe(true);
});

test("is idempotent on a second run", () => {
  const first = mergeManagedSection("", "mcpServers", { a: { url: "https://a" } }, []);
  const second = mergeManagedSection(first.next, "mcpServers", { a: { url: "https://a" } }, first.ownedNow);
  expect(second.changed).toBe(false);
});

test("mergeHooks replaces only wagglebot-marked entries and keeps foreign hooks", () => {
  const existing = JSON.stringify({
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-hook" }] }] },
  });
  const fragment = {
    hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "echo wagglebot:ste" }] }] },
  };
  const once = mergeHooks(existing, fragment);
  const doc = JSON.parse(once.next);
  expect(doc.hooks.PostToolUse).toHaveLength(2);
  expect(JSON.stringify(doc.hooks.PostToolUse[0])).toContain("my-own-hook");
  const twice = mergeHooks(once.next, fragment);
  expect(twice.changed).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/managed-json.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
type JsonObject = Record<string, unknown>;

const parseObject = (text: string): JsonObject => {
  if (text.trim() === "") return {};
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("managed json: the target file is not a JSON object");
  }
  return raw as JsonObject;
};
const print = (doc: JsonObject): string => `${JSON.stringify(doc, null, 2)}\n`;
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export function mergeManagedSection(
  existingText: string,
  parentKey: string,
  entries: Record<string, unknown>,
  previouslyOwned: string[],
): { next: string; changed: boolean; ownedNow: string[] } {
  const doc = parseObject(existingText);
  const parent = isObject(doc[parentKey]) ? { ...(doc[parentKey] as JsonObject) } : {};
  const stale = previouslyOwned.filter((k) => !(k in entries));
  for (const k of stale) delete parent[k];
  for (const [k, v] of Object.entries(entries)) parent[k] = v;
  doc[parentKey] = parent;
  const next = print(doc);
  return { next, changed: existingText.trim() === "" || next !== print(parseObject(existingText)) ? next !== `${existingText}` : false, ownedNow: Object.keys(entries) };
}

const carriesMarker = (element: unknown): boolean => JSON.stringify(element).includes("wagglebot:");

export function mergeHooks(
  existingText: string,
  fragment: { hooks: Record<string, unknown[]> },
): { next: string; changed: boolean } {
  const doc = parseObject(existingText);
  const hooks = isObject(doc.hooks) ? { ...(doc.hooks as JsonObject) } : {};
  for (const [event, fragmentEntries] of Object.entries(fragment.hooks)) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const foreign = current.filter((e) => !carriesMarker(e));
    hooks[event] = [...foreign, ...fragmentEntries];
  }
  doc.hooks = hooks;
  const next = print(doc);
  return { next, changed: next !== existingText };
}
```

NOTE: simplify the `changed` computation in `mergeManagedSection` to `next !== existingText` when `existingText` was produced by this tool (it always is after the first run); the test above defines the required behavior — implement to the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/managed-json.test.ts` — expected: PASS. Adjust the `changed` logic until all three tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/managed-json.ts packages/cli/src/managed-json.test.ts
git commit -m "feat(cli): per-key JSON ownership and hook fragment merge"
```

---

### Task 7: List Parser

**Files:**
- Create: `packages/cli/src/lists.ts`
- Test: `packages/cli/src/lists.test.ts`

**Interfaces:**
- Produces:

```ts
export type ListEntry = { repo: string; ref?: string; raw: string }; // repo = "owner/name"
export function parseList(text: string): { entries: ListEntry[]; warnings: string[] };
```

Rules from the spec: one entry per line, `owner/repo` with optional `@<ref>`; `#` starts a comment (full line or trailing); blank lines are ignored. An entry without a pin produces one warning (`"<repo>: no pin — required for a third-party repository (D32)"`). A malformed line (no `/`, or whitespace inside the entry) throws an `Error` naming the line.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { parseList } from "./lists";

test("parses entries, comments, pins, and warns on unpinned lines", () => {
  const text = [
    "# curated skills",
    "obra/superpowers@v4.2.0",
    "wagglebot/skills@3f2a9c1   # first-party",
    "acme/internal-skills",
    "",
  ].join("\n");
  const { entries, warnings } = parseList(text);
  expect(entries).toEqual([
    { repo: "obra/superpowers", ref: "v4.2.0", raw: "obra/superpowers@v4.2.0" },
    { repo: "wagglebot/skills", ref: "3f2a9c1", raw: "wagglebot/skills@3f2a9c1" },
    { repo: "acme/internal-skills", ref: undefined, raw: "acme/internal-skills" },
  ]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("acme/internal-skills");
});

test("a malformed line throws and names the line", () => {
  expect(() => parseList("not-a-repo")).toThrow("not-a-repo");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/lists.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export type ListEntry = { repo: string; ref?: string; raw: string };

export function parseList(text: string): { entries: ListEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const entries = text
    .split("\n")
    .map((line) => line.split("#")[0]?.trim() ?? "")
    .filter((line) => line !== "")
    .map((raw) => {
      const at = raw.indexOf("@");
      const repo = at === -1 ? raw : raw.slice(0, at);
      const ref = at === -1 ? undefined : raw.slice(at + 1);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || ref === "") {
        throw new Error(`list entry is malformed: "${raw}" — expected owner/repo[@ref]`);
      }
      if (ref === undefined) warnings.push(`${repo}: no pin — required for a third-party repository (D32)`);
      return { repo, ref, raw };
    });
  return { entries, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/lists.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lists.ts packages/cli/src/lists.test.ts
git commit -m "feat(cli): skills and agents list parser with pin warnings"
```

---

### Task 8: Catalog Loader

**Files:**
- Create: `packages/cli/src/catalog.ts`
- Test: `packages/cli/src/catalog.test.ts`

**Interfaces:**
- Consumes: the `yaml` package (`import { parseAllDocuments } from "yaml"`).
- Produces:

```ts
export type Catalog = {
  domains: { name: string; owner: string }[];
  systems: { name: string; owner: string; domain: string }[];
  groups: { name: string; parent?: string; members: string[] }[];
  users: { name: string; memberOf: string[]; orgOwner: boolean }[];
};
export function loadCatalog(text: string, fileName: string): Catalog; // throws on any duplicate or unknown reference (D27)
export function findUser(catalog: Catalog, username: string): Catalog["users"][number] | undefined;
export function nearMatches(catalog: Catalog, username: string): string[]; // usernames with edit distance <= 2, sorted
export function teamsOf(catalog: Catalog, username: string): string[]; // union of user.memberOf and groups whose members include the user
```

Validation (D27, P35), each a thrown `Error` naming `fileName` and the value:
- Two entities of one kind sharing a name.
- A System naming an unknown `domain` or `owner` Group.
- A Domain naming an unknown `owner` Group.
- A Group `parent` or `members` entry naming an unknown Group/no-op (members reference Users; an unknown member is an error).
- A User `memberOf` entry naming an unknown Group.
- An entity missing `metadata.name`.

The org-owner flag reads `metadata.annotations["wagglebot.dev/org-owner"] === "true"`.

- [ ] **Step 1: Move `yaml` into place and write the failing test**

`yaml` is already a devDependency (Task 1) and gets bundled by `bun build`. Test:

```ts
import { expect, test } from "bun:test";
import { findUser, loadCatalog, nearMatches, teamsOf } from "./catalog";

const CATALOG = `
apiVersion: backstage.io/v1alpha1
kind: Domain
metadata: { name: payments }
spec: { owner: team-payments }
---
apiVersion: backstage.io/v1alpha1
kind: System
metadata: { name: payments-platform }
spec: { owner: team-payments, domain: payments }
---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata: { name: team-payments }
spec: { type: team, members: [alice, bob] }
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice
  annotations: { "wagglebot.dev/org-owner": "true" }
spec: { memberOf: [team-payments] }
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata: { name: bob }
spec: { memberOf: [team-payments] }
`;

test("loads a valid catalog and resolves users and teams", () => {
  const catalog = loadCatalog(CATALOG, "catalog.yaml");
  expect(findUser(catalog, "alice")?.orgOwner).toBe(true);
  expect(teamsOf(catalog, "bob")).toEqual(["team-payments"]);
});

test("near matches suggest close usernames", () => {
  const catalog = loadCatalog(CATALOG, "catalog.yaml");
  expect(nearMatches(catalog, "alcie")).toEqual(["alice"]);
});

test("a system naming an unknown group is a hard error naming file and value", () => {
  const broken = CATALOG.replace("owner: team-payments, domain", "owner: team-ghost, domain");
  expect(() => loadCatalog(broken, "catalog.yaml")).toThrow(/catalog\.yaml.*team-ghost/);
});

test("duplicate names of one kind are a hard error", () => {
  const dup = `${CATALOG}\n---\napiVersion: backstage.io/v1alpha1\nkind: User\nmetadata: { name: bob }\nspec: { memberOf: [team-payments] }\n`;
  expect(() => loadCatalog(dup, "catalog.yaml")).toThrow(/bob/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/catalog.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { parseAllDocuments } from "yaml";

export type Catalog = {
  domains: { name: string; owner: string }[];
  systems: { name: string; owner: string; domain: string }[];
  groups: { name: string; parent?: string; members: string[] }[];
  users: { name: string; memberOf: string[]; orgOwner: boolean }[];
};

type Entity = { kind: string; metadata: { name?: string; annotations?: Record<string, string> }; spec?: Record<string, unknown> };

const fail = (file: string, message: string): never => {
  throw new Error(`${file}: ${message}`);
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function loadCatalog(text: string, fileName: string): Catalog {
  const docs = parseAllDocuments(text)
    .map((d) => d.toJS() as Entity | null)
    .filter((d): d is Entity => d !== null);
  const byKind = (kind: string) => docs.filter((d) => d.kind === kind);
  const name = (e: Entity): string => e.metadata?.name ?? fail(fileName, `a ${e.kind} entity has no metadata.name`);

  const catalog: Catalog = {
    domains: byKind("Domain").map((e) => ({ name: name(e), owner: str(e.spec?.owner) })),
    systems: byKind("System").map((e) => ({ name: name(e), owner: str(e.spec?.owner), domain: str(e.spec?.domain) })),
    groups: byKind("Group").map((e) => ({
      name: name(e),
      parent: e.spec?.parent === undefined ? undefined : str(e.spec.parent),
      members: strings(e.spec?.members),
    })),
    users: byKind("User").map((e) => ({
      name: name(e),
      memberOf: strings(e.spec?.memberOf),
      orgOwner: e.metadata.annotations?.["wagglebot.dev/org-owner"] === "true",
    })),
  };

  for (const [kind, list] of Object.entries({
    Domain: catalog.domains.map((d) => d.name),
    System: catalog.systems.map((s) => s.name),
    Group: catalog.groups.map((g) => g.name),
    User: catalog.users.map((u) => u.name),
  })) {
    const dupes = list.filter((n, i) => list.indexOf(n) !== i);
    if (dupes.length > 0) fail(fileName, `duplicate ${kind} name "${dupes[0]}"`);
  }

  const groupNames = new Set(catalog.groups.map((g) => g.name));
  const userNames = new Set(catalog.users.map((u) => u.name));
  const domainNames = new Set(catalog.domains.map((d) => d.name));
  for (const d of catalog.domains) if (!groupNames.has(d.owner)) fail(fileName, `Domain "${d.name}" names unknown owner Group "${d.owner}"`);
  for (const s of catalog.systems) {
    if (!groupNames.has(s.owner)) fail(fileName, `System "${s.name}" names unknown owner Group "${s.owner}"`);
    if (!domainNames.has(s.domain)) fail(fileName, `System "${s.name}" names unknown Domain "${s.domain}"`);
  }
  for (const g of catalog.groups) {
    if (g.parent !== undefined && !groupNames.has(g.parent)) fail(fileName, `Group "${g.name}" names unknown parent "${g.parent}"`);
    for (const m of g.members) if (!userNames.has(m)) fail(fileName, `Group "${g.name}" names unknown member "${m}"`);
  }
  for (const u of catalog.users) for (const g of u.memberOf) if (!groupNames.has(g)) fail(fileName, `User "${u.name}" names unknown Group "${g}"`);
  return catalog;
}

export const findUser = (catalog: Catalog, username: string) => catalog.users.find((u) => u.name === username);

const distance = (a: string, b: string): number => {
  const rows = [...Array(a.length + 1)].map((_, i) => [i, ...Array<number>(b.length).fill(0)]);
  const first = rows[0];
  if (first !== undefined) for (let j = 0; j <= b.length; j += 1) first[j] = j;
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
    }
  return rows[a.length]![b.length]!;
};

export const nearMatches = (catalog: Catalog, username: string): string[] =>
  catalog.users
    .map((u) => u.name)
    .filter((n) => distance(n, username) <= 2)
    .toSorted();

export const teamsOf = (catalog: Catalog, username: string): string[] => {
  const viaGroups = catalog.groups.filter((g) => g.members.includes(username)).map((g) => g.name);
  const viaUser = findUser(catalog, username)?.memberOf ?? [];
  return [...new Set([...viaUser, ...viaGroups])].toSorted();
};
```

NOTE: the `!` non-null assertions in `distance` follow from `noUncheckedIndexedAccess`; they are assertions, not `as` casts, and stay within §C1. If review rejects them, restructure with local variables.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/catalog.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/catalog.ts packages/cli/src/catalog.test.ts
git commit -m "feat(cli): Backstage catalog loader with hard validation (D20, D27)"
```

---

### Task 9: Exec Helper and Identity

**Files:**
- Create: `packages/cli/src/exec.ts`, `packages/cli/src/identity.ts`
- Test: `packages/cli/src/identity.test.ts`

**Interfaces:**
- Consumes: `Catalog`, `findUser`, `nearMatches` from Task 8.
- Produces:

```ts
// exec.ts
export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;
export const realExec: Exec;

// identity.ts
export type Ask = (question: string) => Promise<string>;
export function getUsername(exec: Exec, ask: Ask, catalog: Catalog): Promise<string>;
```

`getUsername` behavior (phase 1 spec, "stored, never guessed"):
1. Read `git config --global wagglebot.username`.
2. A stored value that matches a User entity is returned.
3. A stored value that matches nothing throws, listing near matches — never accepted silently (P35).
4. No stored value: ask once, validate; a miss throws with near matches; a hit is stored with `git config --global wagglebot.username <answer>` and returned.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { loadCatalog } from "./catalog";
import type { Exec } from "./exec";
import { getUsername } from "./identity";

const catalog = loadCatalog(
  `kind: Group\nmetadata: { name: t }\nspec: { members: [alice] }\n---\nkind: User\nmetadata: { name: alice }\nspec: { memberOf: [t] }\n`,
  "catalog.yaml",
);

const fakeExec = (stored: string, writes: string[][]): Exec => async (cmd, args) => {
  if (args.includes("wagglebot.username") && args.length === 3) return { code: stored === "" ? 1 : 0, stdout: `${stored}\n`, stderr: "" };
  writes.push(args);
  return { code: 0, stdout: "", stderr: "" };
};

test("returns the stored username when it matches the catalog", async () => {
  expect(await getUsername(fakeExec("alice", []), async () => "never", catalog)).toBe("alice");
});

test("asks once, validates, and stores on first run", async () => {
  const writes: string[][] = [];
  expect(await getUsername(fakeExec("", writes), async () => " alice ", catalog)).toBe("alice");
  expect(writes).toEqual([["config", "--global", "wagglebot.username", "alice"]]);
});

test("rejects a non-matching answer with near matches", async () => {
  await expect(getUsername(fakeExec("", []), async () => "alcie", catalog)).rejects.toThrow(/alice/);
});

test("rejects a stored value that no longer matches", async () => {
  await expect(getUsername(fakeExec("ghost", []), async () => "n/a", catalog)).rejects.toThrow(/ghost/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/identity.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// exec.ts
import { execFile } from "node:child_process";
export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
```

```ts
// identity.ts
import type { Catalog } from "./catalog";
import { findUser, nearMatches } from "./catalog";
import type { Exec } from "./exec";

export type Ask = (question: string) => Promise<string>;

const reject = (catalog: Catalog, value: string): never => {
  const near = nearMatches(catalog, value);
  const hint = near.length > 0 ? ` Near matches: ${near.join(", ")}.` : "";
  throw new Error(`username "${value}" matches no User entity in catalog.yaml.${hint}`);
};

export async function getUsername(exec: Exec, ask: Ask, catalog: Catalog): Promise<string> {
  const stored = await exec("git", ["config", "--global", "wagglebot.username"]);
  const current = stored.stdout.trim();
  if (current !== "") {
    if (findUser(catalog, current) === undefined) reject(catalog, current);
    return current;
  }
  const answer = (await ask("Company Git username (as listed in catalog.yaml): ")).trim();
  if (findUser(catalog, answer) === undefined) reject(catalog, answer);
  await exec("git", ["config", "--global", "wagglebot.username", answer]);
  return answer;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/identity.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/exec.ts packages/cli/src/identity.ts packages/cli/src/identity.test.ts
git commit -m "feat(cli): stored engineer identity, validated against the catalog"
```

---

### Task 10: Registry Loader, Validation, and Merge

**Files:**
- Create: `packages/cli/src/registry.ts`
- Test: `packages/cli/src/registry.test.ts`

**Interfaces:**
- Consumes: `yaml` `parse`.
- Produces (`ProxyConfig` copied from §C2):

```ts
export type AuthScheme =
  | { kind: "none" }
  | { kind: "bearer" }
  | { kind: "header"; name: string; prefix?: string }
  | { kind: "basic"; username: string }
  | { kind: "env"; map: Record<string, string> };
export type CredentialSource = { from: "env"; var: string } | { from: "file"; path: string } | { from: "literal"; value: string };
export type ProxyConfig = {
  namespace: string;
  mode: "remote_http" | "remote_sse" | "stdio_npx" | "stdio_cmd";
  endpoint?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  auth?: { scheme: AuthScheme; source: CredentialSource };
};
export function loadRegistry(text: string, fileName: string): ProxyConfig[]; // validates, throws naming file+value
export function mergeRegistries(base: ProxyConfig[], team: ProxyConfig[]): ProxyConfig[]; // shallow by namespace, team wins
```

Validation (§C2, adapted to Phase 1):
- Namespaces unique and free of whitespace.
- `remote_http` / `remote_sse` require an absolute `http(s)` endpoint URL.
- `stdio_npx`: `command` holds the package spec and must end in `@<exact x.y.z>`; reject `latest` and ranges (P31, cross-task decision 2).
- `stdio_cmd` requires `command`.
- A `literal` credential source is a hard error: a shared registry must never carry a secret.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { loadRegistry, mergeRegistries } from "./registry";

test("loads and validates a registry", () => {
  const text = `proxies:\n  - namespace: example\n    mode: remote_http\n    endpoint: https://mcp.example.com/mcp\n    auth:\n      scheme: { kind: bearer }\n      source: { from: env, var: EXAMPLE_TOKEN }\n`;
  const proxies = loadRegistry(text, "registry.base.yaml");
  expect(proxies).toHaveLength(1);
  expect(proxies[0]?.namespace).toBe("example");
});

test("rejects an unpinned stdio_npx package", () => {
  const text = `proxies:\n  - namespace: gh\n    mode: stdio_npx\n    command: "@example/mcp@latest"\n`;
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/r\.yaml.*gh/);
});

test("rejects a literal credential source", () => {
  const text = `proxies:\n  - namespace: x\n    mode: remote_http\n    endpoint: https://x/mcp\n    auth:\n      scheme: { kind: bearer }\n      source: { from: literal, value: hunter2 }\n`;
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/literal/);
});

test("team layer wins per namespace, shallow merge", () => {
  const base = loadRegistry(`proxies:\n  - { namespace: a, mode: remote_http, endpoint: https://a/mcp }\n  - { namespace: b, mode: remote_http, endpoint: https://b/mcp }\n`, "base");
  const team = loadRegistry(`proxies:\n  - { namespace: b, mode: remote_http, endpoint: https://b2/mcp }\n  - { namespace: c, mode: remote_http, endpoint: https://c/mcp }\n`, "team");
  const merged = mergeRegistries(base, team);
  expect(merged.map((p) => `${p.namespace}:${p.endpoint}`)).toEqual(["a:https://a/mcp", "b:https://b2/mcp", "c:https://c/mcp"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/registry.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { parse } from "yaml";

// (AuthScheme, CredentialSource, ProxyConfig type declarations exactly as in Interfaces above)

const MODES = new Set(["remote_http", "remote_sse", "stdio_npx", "stdio_cmd"]);
const EXACT_VERSION = /@\d+\.\d+\.\d+([-+][\w.-]+)?$/;

const fail = (file: string, ns: string, message: string): never => {
  throw new Error(`${file}: proxy "${ns}": ${message}`);
};

export function loadRegistry(text: string, fileName: string): ProxyConfig[] {
  const doc: unknown = parse(text);
  const proxies = typeof doc === "object" && doc !== null && Array.isArray((doc as { proxies?: unknown }).proxies)
    ? ((doc as { proxies: unknown[] }).proxies as ProxyConfig[])
    : [];
  const seen = new Set<string>();
  for (const p of proxies) {
    const ns = p.namespace ?? "";
    if (ns === "" || /\s/.test(ns)) fail(fileName, ns, "namespace must be non-empty without whitespace");
    if (seen.has(ns)) fail(fileName, ns, "duplicate namespace");
    seen.add(ns);
    if (!MODES.has(p.mode)) fail(fileName, ns, `unknown mode "${p.mode}"`);
    if (p.mode === "remote_http" || p.mode === "remote_sse") {
      if (p.endpoint === undefined || !/^https?:\/\//.test(p.endpoint)) fail(fileName, ns, "an absolute http(s) endpoint is required");
    }
    if (p.mode === "stdio_npx" && (p.command === undefined || !EXACT_VERSION.test(p.command))) {
      fail(fileName, ns, `stdio_npx requires an exact pinned package, for example "@example/mcp@1.4.2" (P31); got "${p.command ?? ""}"`);
    }
    if (p.mode === "stdio_cmd" && (p.command === undefined || p.command === "")) fail(fileName, ns, "stdio_cmd requires a command");
    if (p.auth?.source.from === "literal") fail(fileName, ns, "a literal credential source is forbidden — a shared registry must never carry a secret");
  }
  return proxies;
}

export function mergeRegistries(base: ProxyConfig[], team: ProxyConfig[]): ProxyConfig[] {
  const teamNames = new Set(team.map((p) => p.namespace));
  const merged = new Map<string, ProxyConfig>();
  for (const p of base) merged.set(p.namespace, p);
  for (const p of team) merged.set(p.namespace, p);
  return [...base.filter((p) => !teamNames.has(p.namespace)).map((p) => p.namespace), ...team.map((p) => p.namespace)]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((ns) => merged.get(ns))
    .filter((p): p is ProxyConfig => p !== undefined);
}
```

NOTE: the merge output order in the test is alphabetical (`a`, `b`, `c`); keep the sorted order so runs are deterministic and idempotent. The `as` narrowing of the parsed YAML mirrors Task 3's note: replace with a runtime validator if review rejects it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/registry.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/registry.ts packages/cli/src/registry.test.ts
git commit -m "feat(cli): registry loader with pin and secret validation, layered merge"
```

---

### Task 11: Harness Target Table and Template Renderer

**Files:**
- Create: `packages/cli/src/harness.ts`, `packages/cli/src/template.ts`, `packages/cli/templates/AGENTS.base.md`, `packages/cli/templates/hooks/claude-code.json`
- Test: `packages/cli/src/harness.test.ts`, `packages/cli/src/template.test.ts`

**Interfaces:**
- Produces:

```ts
// harness.ts — the target list lives in one place: this module (phase 1 spec, "Distribution")
export type Harness = {
  name: string;
  templateTargets: string[];                        // paths relative to home, e.g. ".claude/CLAUDE.md"
  hooksTarget?: { path: string; fragmentFile: string }; // relative to home / relative to templates/hooks
  mcpTarget?: { path: string; parentKey: string };      // relative to home
  subagentDir?: string;                                 // relative to home
};
export const HARNESSES: Harness[];
export function templatesDir(): string; // resolves packages/cli/templates next to the built dist

// template.ts
export function renderTemplate(base: string, overlays: string[]): string; // trimmed parts joined by "\n\n", trailing "\n"
```

`HARNESSES` content (spec table + cross-task decision 5):

| name | templateTargets | hooksTarget | mcpTarget | subagentDir |
|---|---|---|---|---|
| claude-code | `.claude/CLAUDE.md` | `.claude/settings.json` / `claude-code.json` | `.claude.json` / `mcpServers` | `.claude/agents` |
| codex | `.codex/AGENTS.md` | — | — | — |
| junie | `.junie/AGENTS.md`, `.junie/CLAUDE.md` | — | — | — |
| cline | `.cline/rules/global.md`, `.cline/custom_instructions.md` | — | — | — |
| agents-standard | `.agents/AGENTS.md` | — | — | — |
| gemini | `.gemini/config/GEMINI.md`, `.gemini/config/rules/global.md` | — | — | — |

- [ ] **Step 1: Create the shipped template files**

`packages/cli/templates/AGENTS.base.md`: three sections, copied **verbatim** from the phase 1 spec `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md`: the `## Delegation` block (the fenced markdown at spec lines 294–339), the `## Baseline` block (spec lines 347–437), and the `## Memory` block (spec lines 441–504). Strip the surrounding code fences; the file content is the three sections concatenated in that order, separated by one blank line.

`packages/cli/templates/hooks/claude-code.json` (the seed fragment: re-inject the STE rules on each Markdown write; the `wagglebot:` marker inside the command is the ownership tag — cross-task decision 6):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"const i=require('fs').readFileSync(0,'utf8');const p=JSON.parse(i);const f=(p.tool_input&&p.tool_input.file_path)||'';if(f.endsWith('.md')){console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'wagglebot:ste-reminder — You edited a Markdown file. Re-read the Baseline section and apply ASD-STE100 to the prose.'}}))}\""
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// harness.test.ts
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES, templatesDir } from "./harness";

test("all six harnesses are present with the spec targets", () => {
  expect(HARNESSES.map((h) => h.name)).toEqual(["claude-code", "codex", "junie", "cline", "agents-standard", "gemini"]);
  const claude = HARNESSES[0];
  expect(claude?.templateTargets).toEqual([".claude/CLAUDE.md"]);
  expect(claude?.mcpTarget).toEqual({ path: ".claude.json", parentKey: "mcpServers" });
  expect(claude?.subagentDir).toBe(".claude/agents");
  expect(HARNESSES.filter((h) => h.hooksTarget !== undefined)).toHaveLength(1);
});

test("shipped template files exist", () => {
  expect(existsSync(join(templatesDir(), "AGENTS.base.md"))).toBe(true);
  expect(existsSync(join(templatesDir(), "hooks", "claude-code.json"))).toBe(true);
});
```

```ts
// template.test.ts
import { expect, test } from "bun:test";
import { renderTemplate } from "./template";

test("concatenates base and overlays with blank-line separators", () => {
  expect(renderTemplate("# Base\n", ["## Team A\n", "## Team B"])).toBe("# Base\n\n## Team A\n\n## Team B\n");
});

test("no overlays returns the base normalized", () => {
  expect(renderTemplate("# Base", [])).toBe("# Base\n");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/cli/src/harness.test.ts packages/cli/src/template.test.ts` — expected: FAIL.

- [ ] **Step 4: Implement and re-run to pass**

```ts
// harness.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Harness = {
  name: string;
  templateTargets: string[];
  hooksTarget?: { path: string; fragmentFile: string };
  mcpTarget?: { path: string; parentKey: string };
  subagentDir?: string;
};

export const HARNESSES: Harness[] = [
  {
    name: "claude-code",
    templateTargets: [".claude/CLAUDE.md"],
    hooksTarget: { path: ".claude/settings.json", fragmentFile: "claude-code.json" },
    mcpTarget: { path: ".claude.json", parentKey: "mcpServers" },
    subagentDir: ".claude/agents",
  },
  { name: "codex", templateTargets: [".codex/AGENTS.md"] },
  { name: "junie", templateTargets: [".junie/AGENTS.md", ".junie/CLAUDE.md"] },
  { name: "cline", templateTargets: [".cline/rules/global.md", ".cline/custom_instructions.md"] },
  { name: "agents-standard", templateTargets: [".agents/AGENTS.md"] },
  { name: "gemini", templateTargets: [".gemini/config/GEMINI.md", ".gemini/config/rules/global.md"] },
];

// dist/index.js sits next to templates/ in the published package; src/ sits one level deeper in the repo.
export function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith("src") ? join(here, "..", "templates") : join(here, "..", "templates");
}
```

```ts
// template.ts
export function renderTemplate(base: string, overlays: string[]): string {
  return `${[base, ...overlays].map((part) => part.trim()).filter((part) => part !== "").join("\n\n")}\n`;
}
```

Run: `bun test packages/cli/src/harness.test.ts packages/cli/src/template.test.ts` — expected: PASS. Also run `bun run --cwd packages/cli build && node packages/cli/bin/wagglebot.js --version` to confirm the bundle still resolves `templates/` from `dist/`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/harness.ts packages/cli/src/harness.test.ts packages/cli/src/template.ts packages/cli/src/template.test.ts packages/cli/templates
git commit -m "feat(cli): harness target table, seed base template, hook fragment"
```

---

### Task 12: `sync-agents` Command

**Files:**
- Create: `packages/cli/src/commands/sync-agents.ts`
- Test: `packages/cli/src/commands/sync-agents.test.ts`

**Interfaces:**
- Consumes: `renderManagedBlock` (Task 5), `mergeHooks` (Task 6), `renderTemplate`, `HARNESSES`, `templatesDir` (Task 11), `startBackupSet`, `newestBackupSet`, `restoreSet` (Task 4), `resolvePaths` (Task 3), `Reporter` (Task 2).
- Produces:

```ts
export type SyncOptions = { dryRun?: boolean; restore?: boolean; restoreTarget?: string };
export function runSyncAgents(deps: {
  home: string;
  overlaysDir?: string; // company overlays/, optional (a run outside a company repo still syncs the base)
  reporter: Reporter;
  options?: SyncOptions;
}): number; // 0 on success, 1 when any target failed
```

Behavior (phase 1 spec, "Distribution" and "Harness Hooks"):
1. `--restore`: write the newest backup set back (every file, or one file with `restoreTarget`); report and return.
2. Render: `templates/AGENTS.base.md` + sorted `overlays/*.md`.
3. For each harness, for each `templateTarget`: create missing directories, back up before the first mutation, write via `renderManagedBlock`, `chmod 600`, report `updated` (spec word: "synced") or `ok` ("already ok").
4. For the harness with a `hooksTarget`: merge the fragment via `mergeHooks` into the settings JSON, same backup rule; report per target.
5. `--dry-run`: compute everything, print `would sync <target>` lines through the reporter details, change nothing.
6. Exit non-zero on failure; a single unwritable target is `failed`, the rest still run.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runSyncAgents } from "./sync-agents";

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const overlaysDir = join(home, "company-overlays");
  mkdirSync(overlaysDir);
  writeFileSync(join(overlaysDir, "10-team.md"), "## Team Overlay\n");
  return { home, overlaysDir };
};
const quiet = () => createReporter(() => {}, false);

test("writes every template target inside a managed block, chmod 600", () => {
  const { home, overlaysDir } = setup();
  const code = runSyncAgents({ home, overlaysDir, reporter: quiet() });
  expect(code).toBe(0);
  const claude = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  expect(claude).toContain("<!-- wagglebot:begin -->");
  expect(claude).toContain("## Team Overlay");
  expect(claude).toContain("## Memory");
  expect(statSync(join(home, ".claude/CLAUDE.md")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(home, ".gemini/config/rules/global.md"))).toBe(true);
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  expect(JSON.stringify(settings.hooks)).toContain("wagglebot:");
});

test("second run reports every item ok and changes nothing", () => {
  const { home, overlaysDir } = setup();
  runSyncAgents({ home, overlaysDir, reporter: quiet() });
  const before = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  const r = createReporter(() => {}, false);
  expect(runSyncAgents({ home, overlaysDir, reporter: r })).toBe(0);
  expect(r.counts().updated).toBe(0);
  expect(r.counts().ok).toBeGreaterThan(0);
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe(before);
});

test("content outside the managed block survives, and --restore brings the old file back", () => {
  const { home, overlaysDir } = setup();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# My personal rules\n");
  runSyncAgents({ home, overlaysDir, reporter: quiet() });
  const synced = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
  expect(synced.startsWith("# My personal rules")).toBe(true);
  runSyncAgents({ home, overlaysDir, reporter: quiet(), options: { restore: true } });
  expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("# My personal rules\n");
});

test("--dry-run changes nothing", () => {
  const { home, overlaysDir } = setup();
  runSyncAgents({ home, overlaysDir, reporter: quiet(), options: { dryRun: true } });
  expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/sync-agents.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newestBackupSet, restoreSet, startBackupSet } from "../backup";
import { renderManagedBlock } from "../managed-block";
import { mergeHooks } from "../managed-json";
import { HARNESSES, templatesDir } from "../harness";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";
import { renderTemplate } from "../template";

export type SyncOptions = { dryRun?: boolean; restore?: boolean; restoreTarget?: string };

const readIfExists = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

export function runSyncAgents(deps: { home: string; overlaysDir?: string; reporter: Reporter; options?: SyncOptions }): number {
  const { home, reporter } = deps;
  const options = deps.options ?? {};
  const paths = resolvePaths(home);
  reporter.section("Base template sync");

  if (options.restore === true) {
    const set = newestBackupSet(paths.backupsDir);
    if (set === undefined) {
      reporter.item("restore", "failed", "no backup set exists");
      return 1;
    }
    for (const target of restoreSet(set, options.restoreTarget)) reporter.item(target, "updated", "restored");
    return 0;
  }

  const base = readFileSync(join(templatesDir(), "AGENTS.base.md"), "utf8");
  const overlays =
    deps.overlaysDir !== undefined && existsSync(deps.overlaysDir)
      ? readdirSync(deps.overlaysDir)
          .filter((f) => f.endsWith(".md"))
          .toSorted()
          .map((f) => readFileSync(join(deps.overlaysDir ?? "", f), "utf8"))
      : [];
  const rendered = renderTemplate(base, overlays);
  const backups = startBackupSet(paths.backupsDir);

  const writeTarget = (relative: string, compute: (existing: string) => { next: string; changed: boolean }, mode?: number): void => {
    const target = join(home, relative);
    const result = compute(readIfExists(target));
    if (!result.changed) {
      reporter.item(relative, "ok", "already ok");
      return;
    }
    if (options.dryRun === true) {
      reporter.item(relative, "skipped", `would sync (dry run)`);
      return;
    }
    backups.backup(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, result.next);
    if (mode !== undefined) chmodSync(target, mode);
    reporter.item(relative, "updated", "synced");
  };

  for (const harness of HARNESSES) {
    for (const relative of harness.templateTargets) writeTarget(relative, (existing) => renderManagedBlock(existing, rendered), 0o600);
    if (harness.hooksTarget !== undefined) {
      const fragmentText = readFileSync(join(templatesDir(), "hooks", harness.hooksTarget.fragmentFile), "utf8");
      const fragment: { hooks: Record<string, unknown[]> } = JSON.parse(fragmentText);
      writeTarget(harness.hooksTarget.path, (existing) => mergeHooks(existing, fragment));
    }
  }
  return reporter.failed() ? 1 : 0;
}
```

Wrap each `writeTarget` call site so one thrown error (for example invalid JSON in a settings file) reports that target `failed` with the error message and continues; this is one of the few places where a `try/catch` is warranted — the alternative loses the "one target fails, the rest run" behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/commands/sync-agents.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/sync-agents.ts packages/cli/src/commands/sync-agents.test.ts
git commit -m "feat(cli): sync-agents — render base+overlays into every harness, merge hooks"
```

---

### Task 13: MCP Config Writer

**Files:**
- Create: `packages/cli/src/commands/write-mcp.ts`
- Test: `packages/cli/src/commands/write-mcp.test.ts`

**Interfaces:**
- Consumes: `ProxyConfig` (Task 10), `mergeManagedSection` (Task 6), `HARNESSES` (Task 11), `loadState`/`saveState` (Task 3), `startBackupSet` (Task 4), `Reporter` (Task 2).
- Produces:

```ts
export function proxyToClaudeEntry(p: ProxyConfig): Record<string, unknown>; // exported for tests
export function runWriteMcp(deps: {
  home: string;
  proxies: ProxyConfig[]; // already merged (base + team)
  reporter: Reporter;
  dryRun?: boolean;
}): number;
```

`proxyToClaudeEntry` mapping (credentials only as `${VAR}` strings — cross-task decision 3):

| ProxyConfig | Claude Code entry |
|---|---|
| `remote_http` | `{ type: "http", url: endpoint, headers? }` |
| `remote_sse` | `{ type: "sse", url: endpoint, headers? }` |
| `stdio_cmd` | `{ command, args, env }` |
| `stdio_npx` | `{ command: "npx", args: ["-y", <pinned package>, ...args], env }` |

Auth mapping: `bearer` → header `Authorization: "Bearer ${VAR}"`; `header` → `{ [name]: "<prefix>${VAR}" }`; `basic` → header `Authorization: "Basic ${VAR}"` with a comment-free note in `--help` that the var holds the encoded pair; `env` scheme → each map entry `K: "$SOURCE"` becomes `K: "${VAR}"` in `env`. A `file` credential source in Phase 1 is reported `skipped` for that namespace (the hub handles files in Phase 2); an absent scheme adds nothing.

`runWriteMcp` behavior: for each harness with an `mcpTarget`, write all proxies as managed children under `parentKey` via `mergeManagedSection`, using owned keys from `managed.json` (`"<parentKey>/<child>"` entries for that target path), then store the new owned list. Back up before the first mutation. Harnesses without an `mcpTarget` report one `skipped` line each (R2). A removed registry entry disappears from the config on the next run (stale owned keys).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import type { ProxyConfig } from "../registry";
import { proxyToClaudeEntry, runWriteMcp } from "./write-mcp";

const quiet = () => createReporter(() => {}, false);
const remote: ProxyConfig = {
  namespace: "example",
  mode: "remote_http",
  endpoint: "https://mcp.example.com/mcp",
  auth: { scheme: { kind: "bearer" }, source: { from: "env", var: "EXAMPLE_TOKEN" } },
};

test("maps a bearer remote to an http entry with an env expansion header", () => {
  expect(proxyToClaudeEntry(remote)).toEqual({
    type: "http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
  });
});

test("maps stdio_npx to a pinned npx command", () => {
  const p: ProxyConfig = { namespace: "gh", mode: "stdio_npx", command: "@example/mcp@1.4.2", args: ["--flag"], auth: { scheme: { kind: "env", map: { GH_TOKEN: "$SOURCE" } }, source: { from: "env", var: "MY_GH_TOKEN" } } };
  expect(proxyToClaudeEntry(p)).toEqual({ command: "npx", args: ["-y", "@example/mcp@1.4.2", "--flag"], env: { GH_TOKEN: "${MY_GH_TOKEN}" } });
});

test("writes managed entries, preserves foreign entries, removes stale ones", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { personal: { command: "my-mcp" } } }));
  runWriteMcp({ home, proxies: [remote], reporter: quiet() });
  const doc1 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(doc1.mcpServers.personal).toEqual({ command: "my-mcp" });
  expect(doc1.mcpServers.example.type).toBe("http");
  expect(JSON.stringify(doc1)).not.toContain("hunter2"); // never a secret value
  runWriteMcp({ home, proxies: [], reporter: quiet() }); // registry entry removed
  const doc2 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(doc2.mcpServers.example).toBeUndefined();
  expect(doc2.mcpServers.personal).toBeDefined();
});

test("second identical run reports ok", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  runWriteMcp({ home, proxies: [remote], reporter: quiet() });
  const r = createReporter(() => {}, false);
  runWriteMcp({ home, proxies: [remote], reporter: r });
  expect(r.counts().updated).toBe(0);
  expect(r.counts().ok).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/write-mcp.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startBackupSet } from "../backup";
import { HARNESSES } from "../harness";
import { mergeManagedSection } from "../managed-json";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";
import type { AuthScheme, CredentialSource, ProxyConfig } from "../registry";
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
    return { type: p.mode === "remote_http" ? "http" : "sse", url: p.endpoint, ...(headers === undefined ? {} : { headers }) };
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

export function runWriteMcp(deps: { home: string; proxies: ProxyConfig[]; reporter: Reporter; dryRun?: boolean }): number {
  const { home, proxies, reporter } = deps;
  const paths = resolvePaths(home);
  const state = loadState(paths.managedFile);
  const backups = startBackupSet(paths.backupsDir);
  reporter.section("MCP configs");

  for (const harness of HARNESSES) {
    if (harness.mcpTarget === undefined) {
      reporter.item(harness.name, "skipped", "no MCP config adapter in Phase 1 (R2)");
      continue;
    }
    const target = join(home, harness.mcpTarget.path);
    const usable = proxies.filter((p) => !(p.auth !== undefined && p.auth.source.from === "file"));
    for (const p of proxies.filter((x) => !usable.includes(x))) reporter.item(p.namespace, "skipped", "file credential source arrives with the Phase 2 hub");
    const entries = Object.fromEntries(usable.map((p) => [p.namespace, proxyToClaudeEntry(p)]));
    const prefix = `${harness.mcpTarget.parentKey}/`;
    const previouslyOwned = (state.jsonKeys[target] ?? []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
    const result = mergeManagedSection(existing, harness.mcpTarget.parentKey, entries, previouslyOwned);
    if (!result.changed) {
      reporter.item(harness.mcpTarget.path, "ok", "already ok");
      continue;
    }
    if (deps.dryRun === true) {
      reporter.item(harness.mcpTarget.path, "skipped", "would write (dry run)");
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
    reporter.item(harness.mcpTarget.path, "updated", `${result.ownedNow.length} managed entries`);
  }
  return reporter.failed() ? 1 : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/commands/write-mcp.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/write-mcp.ts packages/cli/src/commands/write-mcp.test.ts
git commit -m "feat(cli): MCP config writer — managed entries, env expansions, no secrets"
```

---

### Task 14: `install-skills` Command

**Files:**
- Create: `packages/cli/src/commands/install-skills.ts`
- Test: `packages/cli/src/commands/install-skills.test.ts`
- Modify: `packages/cli/package.json` (add the pinned `skills` dependency)

**Interfaces:**
- Consumes: `parseList` (Task 7), `Exec` (Task 9), `Reporter` (Task 2).
- Produces:

```ts
export function runInstallSkills(deps: {
  listText: string | undefined; // contents of skills.list; undefined -> skipped section
  listPath: string;             // for messages and --update rewrite
  exec: Exec;
  reporter: Reporter;
  skillsBin: string;            // absolute path to the skills CLI binary
  update?: boolean;
  writeList?: (text: string) => void; // required when update is true
}): Promise<number>;
export function resolveSkillsBin(): string; // require.resolve("skills/package.json") -> its bin path
```

Behavior (phase 1 spec, "Skills Installer"):
1. The `skills` CLI version is pinned in wagglebot's own `dependencies` — resolve the binary from the installed dependency, never a global install.
2. For each entry: `exec(skillsBin, ["add", entry.raw, "-g", "-y"])`. Exit 0 whose stdout contains `already` → `ok`; other exit 0 → `installed`; non-zero → `failed` with the first stderr line. Continue on failure; exit non-zero at the end (spec: "warns and continues … exits non-zero on failures").
3. `--update`: for each pinned entry, `exec("git", ["ls-remote", "https://github.com/<repo>.git", "HEAD"])`, take the 40-char hash, rewrite the pin in the list text, and call `writeList` with the new content — the diff stays uncommitted, for review ("bumps the pins in skills.list for review").
4. A missing `skills.list` (undefined) reports one `skipped` line and returns 0.

- [ ] **Step 1: Pin the dependency**

Add to `packages/cli/package.json` `"dependencies": { "skills": "<exact version>" }`. Resolve the exact current version first: `npm view skills version` — pin what it prints (D13). If the package name `skills` does not exist on npm, stop and ask the user which skills CLI package the spec means; do not guess a name.

- [ ] **Step 2: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createReporter } from "../report";
import type { Exec } from "../exec";
import { runInstallSkills } from "./install-skills";

const quiet = () => createReporter(() => {}, false);
const HASH = "a".repeat(40);

const fakeExec = (calls: string[][]): Exec => async (cmd, args) => {
  calls.push([cmd, ...args]);
  if (cmd === "git") return { code: 0, stdout: `${HASH}\tHEAD\n`, stderr: "" };
  if (args.includes("fail/fail@v1")) return { code: 1, stdout: "", stderr: "clone failed" };
  if (args.includes("ok/ok@v1")) return { code: 0, stdout: "already installed", stderr: "" };
  return { code: 0, stdout: "installed", stderr: "" };
};

test("installs each entry, counts, and exits non-zero on a failure", async () => {
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    listText: "new/new@v2\nok/ok@v1\nfail/fail@v1\n",
    listPath: "skills.list",
    exec: fakeExec(calls),
    reporter: r,
    skillsBin: "/bin/skills",
  });
  expect(code).toBe(1);
  expect(r.counts()).toMatchObject({ installed: 1, ok: 1, failed: 1 });
  expect(calls[0]).toEqual(["/bin/skills", "add", "new/new@v2", "-g", "-y"]);
});

test("--update rewrites pins to the remote HEAD hash for review", async () => {
  let written = "";
  const code = await runInstallSkills({
    listText: "# comment\nobra/superpowers@v4.2.0\n",
    listPath: "skills.list",
    exec: fakeExec([]),
    reporter: quiet(),
    skillsBin: "/bin/skills",
    update: true,
    writeList: (t) => {
      written = t;
    },
  });
  expect(code).toBe(0);
  expect(written).toContain(`obra/superpowers@${HASH}`);
  expect(written).toContain("# comment");
});

test("a missing list is skipped, exit 0", async () => {
  const code = await runInstallSkills({ listText: undefined, listPath: "skills.list", exec: fakeExec([]), reporter: quiet(), skillsBin: "/bin/skills" });
  expect(code).toBe(0);
});
```

- [ ] **Step 3: Run test to verify it fails, then implement**

Run: `bun test packages/cli/src/commands/install-skills.test.ts` — expected: FAIL. Then:

```ts
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Exec } from "../exec";
import { parseList } from "../lists";
import type { Reporter } from "../report";

export function resolveSkillsBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("skills/package.json");
  const pkg: { bin: string | Record<string, string> } = require("skills/package.json");
  const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.skills ?? Object.values(pkg.bin)[0] ?? "");
  return join(dirname(pkgPath), rel);
}

export async function runInstallSkills(deps: {
  listText: string | undefined;
  listPath: string;
  exec: Exec;
  reporter: Reporter;
  skillsBin: string;
  update?: boolean;
  writeList?: (text: string) => void;
}): Promise<number> {
  const { reporter } = deps;
  reporter.section("Skills");
  if (deps.listText === undefined) {
    reporter.item(deps.listPath, "skipped", "file not found");
    return 0;
  }
  const { entries, warnings } = parseList(deps.listText);
  for (const w of warnings) reporter.item(w, "skipped", "warning only");

  if (deps.update === true) {
    let text = deps.listText;
    for (const entry of entries.filter((e) => e.ref !== undefined)) {
      const remote = await deps.exec("git", ["ls-remote", `https://github.com/${entry.repo}.git`, "HEAD"]);
      const hash = remote.stdout.slice(0, 40);
      if (remote.code !== 0 || !/^[0-9a-f]{40}$/.test(hash)) {
        reporter.item(entry.repo, "failed", "could not resolve remote HEAD");
        continue;
      }
      text = text.replace(entry.raw, `${entry.repo}@${hash}`);
      reporter.item(entry.repo, "updated", `pin -> ${hash.slice(0, 12)}`);
    }
    deps.writeList?.(text);
    return reporter.failed() ? 1 : 0;
  }

  for (const entry of entries) {
    const result = await deps.exec(deps.skillsBin, ["add", entry.raw, "-g", "-y"]);
    if (result.code !== 0) reporter.item(entry.raw, "failed", result.stderr.split("\n")[0] ?? "");
    else if (result.stdout.includes("already")) reporter.item(entry.raw, "ok", "already installed");
    else reporter.item(entry.raw, "installed");
  }
  return reporter.failed() ? 1 : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/commands/install-skills.test.ts` — expected: PASS. Also `bun install` to materialize the new dependency, and `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json bun.lock packages/cli/src/commands/install-skills.ts packages/cli/src/commands/install-skills.test.ts
git commit -m "feat(cli): install-skills — pinned skills CLI, list install, --update pin bump"
```

---

### Task 15: `install-agents` Command

**Files:**
- Create: `packages/cli/src/commands/install-agents.ts`
- Test: `packages/cli/src/commands/install-agents.test.ts`

**Interfaces:**
- Consumes: `parseList` (Task 7), `Exec` (Task 9), `HARNESSES` (Task 11), `loadState`/`saveState` (Task 3), `Reporter`.
- Produces:

```ts
export function runInstallAgents(deps: {
  home: string;
  listTexts: { path: string; text: string }[]; // agents.base.list + agents.team.<team>.list, in order
  exec: Exec;
  reporter: Reporter;
}): Promise<number>;
```

Behavior (phase 1 spec, "Custom Agent Distribution"):
1. Parse all lists; entries compose in order (base first, then team).
2. For each entry, materialize the repository in `<agentsCacheDir>/<owner>__<repo>`:
   - Missing: `git clone https://github.com/<owner>/<repo>.git <dir>`, then `git -C <dir> checkout <ref>` when pinned.
   - Present: `git -C <dir> fetch --tags origin` then `checkout <ref>` (pinned) or `git -C <dir> pull --ff-only` (unpinned).
3. Copy every top-level `*.md` file from the repository into each harness `subagentDir`, named `<owner>__<repo>__<file>` to avoid collisions. Compare content first: identical → `ok`, new/different → `installed`/`updated`.
4. Record installed file paths in `state.agentFiles`. Files recorded earlier and no longer produced by any entry are deleted (a removed list entry uninstalls).
5. A harness without a `subagentDir` reports one `skipped` line ("no subagent support in Phase 1, R2"). A failing clone reports `failed` and continues.

- [ ] **Step 1: Write the failing test**

The fake exec simulates git by writing files:

```ts
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import type { Exec } from "../exec";
import { runInstallAgents } from "./install-agents";

const quiet = () => createReporter(() => {}, false);

// "clone" creates the dir with one agent file; every other git call is a no-op success.
const fakeGit: Exec = async (cmd, args) => {
  if (cmd === "git" && args[0] === "clone") {
    const dir = args.at(-1) ?? "";
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "reviewer.md"), "# Reviewer agent\n");
    return { code: 0, stdout: "", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

test("installs list agents into the Claude Code subagent dir with prefixed names", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const code = await runInstallAgents({
    home,
    listTexts: [{ path: "agents.base.list", text: "acme/agents@abc1234\n" }],
    exec: fakeGit,
    reporter: quiet(),
  });
  expect(code).toBe(0);
  const installed = join(home, ".claude/agents/acme__agents__reviewer.md");
  expect(readFileSync(installed, "utf8")).toBe("# Reviewer agent\n");
});

test("second run reports ok; a removed entry uninstalls its files", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const lists = [{ path: "agents.base.list", text: "acme/agents@abc1234\n" }];
  await runInstallAgents({ home, listTexts: lists, exec: fakeGit, reporter: quiet() });
  const r = createReporter(() => {}, false);
  await runInstallAgents({ home, listTexts: lists, exec: fakeGit, reporter: r });
  expect(r.counts().ok).toBeGreaterThan(0);
  expect(r.counts().installed).toBe(0);
  await runInstallAgents({ home, listTexts: [{ path: "agents.base.list", text: "" }], exec: fakeGit, reporter: quiet() });
  expect(existsSync(join(home, ".claude/agents/acme__agents__reviewer.md"))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/install-agents.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../exec";
import { HARNESSES } from "../harness";
import { parseList } from "../lists";
import { resolvePaths } from "../paths";
import type { Reporter } from "../report";
import { loadState, saveState } from "../state";

export async function runInstallAgents(deps: {
  home: string;
  listTexts: { path: string; text: string }[];
  exec: Exec;
  reporter: Reporter;
}): Promise<number> {
  const { home, exec, reporter } = deps;
  const paths = resolvePaths(home);
  const state = loadState(paths.managedFile);
  reporter.section("Custom agents");

  const entries = deps.listTexts.flatMap(({ text }) => parseList(text).entries);
  const targets = HARNESSES.filter((h) => h.subagentDir !== undefined);
  for (const h of HARNESSES.filter((x) => x.subagentDir === undefined)) reporter.item(h.name, "skipped", "no subagent support in Phase 1 (R2)");

  const produced: string[] = [];
  for (const entry of entries) {
    const cacheDir = join(paths.agentsCacheDir, entry.repo.replace("/", "__"));
    const git = async (...args: string[]) => exec("git", args);
    const materialize = async (): Promise<boolean> => {
      if (!existsSync(cacheDir)) {
        mkdirSync(paths.agentsCacheDir, { recursive: true });
        const clone = await git("clone", `https://github.com/${entry.repo}.git`, cacheDir);
        if (clone.code !== 0) return false;
      } else if (entry.ref !== undefined) {
        await git("-C", cacheDir, "fetch", "--tags", "origin");
      } else {
        await git("-C", cacheDir, "pull", "--ff-only");
      }
      if (entry.ref !== undefined) {
        const co = await git("-C", cacheDir, "checkout", entry.ref);
        if (co.code !== 0) return false;
      }
      return true;
    };
    if (!(await materialize())) {
      reporter.item(entry.raw, "failed", "git clone/checkout failed");
      continue;
    }
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".md"));
    for (const harness of targets) {
      const dir = join(home, harness.subagentDir ?? "");
      mkdirSync(dir, { recursive: true });
      for (const file of files) {
        const dest = join(dir, `${entry.repo.replace("/", "__")}__${file}`);
        const content = readFileSync(join(cacheDir, file), "utf8");
        produced.push(dest);
        if (existsSync(dest) && readFileSync(dest, "utf8") === content) {
          reporter.item(dest, "ok", "already ok");
          continue;
        }
        const fresh = !existsSync(dest);
        writeFileSync(dest, content);
        reporter.item(dest, fresh ? "installed" : "updated");
      }
    }
  }

  for (const stale of state.agentFiles.filter((f) => !produced.includes(f) && existsSync(f))) {
    rmSync(stale);
    reporter.item(stale, "updated", "removed — no longer listed");
  }
  state.agentFiles = produced;
  saveState(paths.managedFile, state);
  return reporter.failed() ? 1 : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/commands/install-agents.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/install-agents.ts packages/cli/src/commands/install-agents.test.ts
git commit -m "feat(cli): install-agents — list-driven subagent distribution with uninstall"
```

---

### Task 16: Company Repo Loader and `update` Command

**Files:**
- Create: `packages/cli/src/company.ts`, `packages/cli/src/commands/update.ts`
- Test: `packages/cli/src/company.test.ts`, `packages/cli/src/commands/update.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
// company.ts
export type CompanyRepo = {
  root: string;
  pin: string; // dependencies.wagglebot from package.json
  catalogText: string;
  registryBaseText?: string;
  registryTeamText: (team: string) => string | undefined; // registry.team.<team>.yaml
  skillsListText?: string;
  agentListTexts: (teams: string[]) => { path: string; text: string }[]; // agents.base.list + per-team
  overlaysDir: string; // <root>/overlays
};
export function findCompanyRoot(cwd: string): string; // walk up to a package.json with dependencies.wagglebot; throws with guidance when absent
export function loadCompanyRepo(root: string): CompanyRepo;

// commands/update.ts
export function runUpdate(deps: {
  cwd: string;
  home: string;
  exec: Exec;
  ask: Ask;
  reporter: Reporter;
  write: (line: string) => void;
  skillsBin: string;
  skipSelfUpdate?: boolean; // set by the re-exec after a pin move
}): Promise<number>;
```

`runUpdate` does the four spec steps, in order:
1. `git pull --ff-only` in the company root (a failure is fatal: report and return 1).
2. Re-read the pin. When it moved and `skipSelfUpdate` is not set: `yarn install`, then re-exec the fresh CLI — `exec("yarn", ["wagglebot", "update", "--skip-self-update"], { cwd: root })` — stream its output via `write`, and return its exit code.
3. Load the catalog, resolve the username (`getUsername`), resolve teams (`teamsOf`), then run in order: `runInstallSkills`, `runInstallAgents`, `runSyncAgents`, `runWriteMcp` (registry base + all team layers merged in team-name order).
4. `write(reporter.summary())`; return 1 when any item failed.

- [ ] **Step 1: Write the failing tests**

```ts
// company.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCompanyRoot, loadCompanyRepo } from "./company";

const scaffold = () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-co-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.4.2" } }));
  writeFileSync(join(root, "catalog.yaml"), "kind: User\nmetadata: { name: alice }\nspec: { memberOf: [] }\n");
  writeFileSync(join(root, "registry.base.yaml"), "proxies: []\n");
  writeFileSync(join(root, "skills.list"), "");
  writeFileSync(join(root, "agents.base.list"), "");
  mkdirSync(join(root, "overlays"));
  mkdirSync(join(root, "nested/deep"), { recursive: true });
  return root;
};

test("finds the company root from a nested cwd and reads the pin", () => {
  const root = scaffold();
  expect(findCompanyRoot(join(root, "nested/deep"))).toBe(root);
  expect(loadCompanyRepo(root).pin).toBe("1.4.2");
});

test("no company repo above cwd throws with guidance", () => {
  expect(() => findCompanyRoot(mkdtempSync(join(tmpdir(), "wgl-none-")))).toThrow(/company repository/);
});
```

```ts
// commands/update.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import type { Exec } from "../exec";
import { runUpdate } from "./update";

const scaffoldCompany = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wgl-co-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.4.2" } }));
  writeFileSync(
    join(root, "catalog.yaml"),
    "kind: Group\nmetadata: { name: t }\nspec: { members: [alice] }\n---\nkind: User\nmetadata: { name: alice }\nspec: { memberOf: [t] }\n",
  );
  writeFileSync(join(root, "registry.base.yaml"), "proxies:\n  - { namespace: ex, mode: remote_http, endpoint: https://ex/mcp }\n");
  mkdirSync(join(root, "overlays"));
  return root;
};

const gitExec = (calls: string[][]): Exec => async (cmd, args, opts) => {
  calls.push([cmd, ...args]);
  if (cmd === "git" && args.includes("wagglebot.username")) return { code: 0, stdout: "alice\n", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

test("pulls, provisions, and prints a summary", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const calls: string[][] = [];
  const lines: string[] = [];
  const code = await runUpdate({
    cwd: root,
    home,
    exec: gitExec(calls),
    ask: async () => "alice",
    reporter: createReporter((l) => lines.push(l), false),
    write: (l) => lines.push(l),
    skillsBin: "/bin/skills",
  });
  expect(code).toBe(0);
  expect(calls[0]).toEqual(["git", "pull", "--ff-only"]);
  expect(lines.join("\n")).toContain("failed 0");
});

test("a moved pin triggers yarn install and a re-exec, once", async () => {
  const root = scaffoldCompany();
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "pull") {
      // the pull moves the pin
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.5.0" } }));
    }
    if (cmd === "git" && args.includes("wagglebot.username")) return { code: 0, stdout: "alice\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const quiet = createReporter(() => {}, false);
  const code = await runUpdate({ cwd: root, home, exec, ask: async () => "alice", reporter: quiet, write: () => {}, skillsBin: "/bin/skills" });
  expect(code).toBe(0);
  expect(calls).toContainEqual(["yarn", "install"]);
  expect(calls).toContainEqual(["yarn", "wagglebot", "update", "--skip-self-update"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/company.test.ts packages/cli/src/commands/update.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// company.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CompanyRepo = {
  root: string;
  pin: string;
  catalogText: string;
  registryBaseText?: string;
  registryTeamText: (team: string) => string | undefined;
  skillsListText?: string;
  agentListTexts: (teams: string[]) => { path: string; text: string }[];
  overlaysDir: string;
};

const readOptional = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

const pinOf = (root: string): string | undefined => {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  const pkg: { dependencies?: Record<string, string> } = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.dependencies?.wagglebot;
};

export function findCompanyRoot(cwd: string): string {
  let dir = cwd;
  while (true) {
    if (pinOf(dir) !== undefined) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `no company repository found above ${cwd}. Run this command inside the repository scaffolded by "bunx wagglebot@<version> init" — its package.json pins the "wagglebot" dependency.`,
      );
    }
    dir = parent;
  }
}

export function loadCompanyRepo(root: string): CompanyRepo {
  const pin = pinOf(root);
  if (pin === undefined) throw new Error(`${root}/package.json does not pin the "wagglebot" dependency`);
  const catalogText = readOptional(join(root, "catalog.yaml"));
  if (catalogText === undefined) throw new Error(`${root}/catalog.yaml is missing — the catalog is required (D20)`);
  return {
    root,
    pin,
    catalogText,
    registryBaseText: readOptional(join(root, "registry.base.yaml")),
    registryTeamText: (team) => readOptional(join(root, `registry.team.${team}.yaml`)),
    skillsListText: readOptional(join(root, "skills.list")),
    agentListTexts: (teams) =>
      [
        { path: "agents.base.list", text: readOptional(join(root, "agents.base.list")) },
        ...teams.map((t) => ({ path: `agents.team.${t}.list`, text: readOptional(join(root, `agents.team.${t}.list`)) })),
      ].flatMap((x) => (x.text === undefined ? [] : [{ path: x.path, text: x.text }])),
    overlaysDir: join(root, "overlays"),
  };
}
```

```ts
// commands/update.ts
import { join } from "node:path";
import { loadCatalog, teamsOf } from "../catalog";
import { findCompanyRoot, loadCompanyRepo } from "../company";
import type { Exec } from "../exec";
import type { Ask } from "../identity";
import { getUsername } from "../identity";
import { loadRegistry, mergeRegistries } from "../registry";
import type { Reporter } from "../report";
import { runInstallAgents } from "./install-agents";
import { runInstallSkills } from "./install-skills";
import { runSyncAgents } from "./sync-agents";
import { runWriteMcp } from "./write-mcp";

export async function runUpdate(deps: {
  cwd: string;
  home: string;
  exec: Exec;
  ask: Ask;
  reporter: Reporter;
  write: (line: string) => void;
  skillsBin: string;
  skipSelfUpdate?: boolean;
}): Promise<number> {
  const { exec, reporter, write } = deps;
  const root = findCompanyRoot(deps.cwd);
  const pinBefore = loadCompanyRepo(root).pin;

  const pull = await exec("git", ["pull", "--ff-only"], { cwd: root });
  if (pull.code !== 0) {
    reporter.item("git pull --ff-only", "failed", pull.stderr.split("\n")[0] ?? "");
    write(reporter.summary());
    return 1;
  }

  const company = loadCompanyRepo(root);
  if (company.pin !== pinBefore && deps.skipSelfUpdate !== true) {
    write(`wagglebot pin moved ${pinBefore} -> ${company.pin}; running yarn install`);
    const install = await exec("yarn", ["install"], { cwd: root });
    if (install.code !== 0) {
      reporter.item("yarn install", "failed", install.stderr.split("\n")[0] ?? "");
      return 1;
    }
    const rerun = await exec("yarn", ["wagglebot", "update", "--skip-self-update"], { cwd: root });
    write(rerun.stdout);
    return rerun.code;
  }

  const catalog = loadCatalog(company.catalogText, join(root, "catalog.yaml"));
  const username = await getUsername(exec, deps.ask, catalog);
  const teams = teamsOf(catalog, username);

  await runInstallSkills({
    listText: company.skillsListText,
    listPath: join(root, "skills.list"),
    exec,
    reporter,
    skillsBin: deps.skillsBin,
  });
  await runInstallAgents({ home: deps.home, listTexts: company.agentListTexts(teams), exec, reporter });
  runSyncAgents({ home: deps.home, overlaysDir: company.overlaysDir, reporter });

  const base = company.registryBaseText === undefined ? [] : loadRegistry(company.registryBaseText, "registry.base.yaml");
  const merged = teams.reduce((acc, team) => {
    const text = company.registryTeamText(team);
    return text === undefined ? acc : mergeRegistries(acc, loadRegistry(text, `registry.team.${team}.yaml`));
  }, base);
  runWriteMcp({ home: deps.home, proxies: merged, reporter });

  write(reporter.summary());
  return reporter.failed() ? 1 : 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/company.test.ts packages/cli/src/commands/update.test.ts` — expected: PASS. Then run the full suite: `bun test` — expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/company.ts packages/cli/src/company.test.ts packages/cli/src/commands/update.ts packages/cli/src/commands/update.test.ts
git commit -m "feat(cli): wagglebot update — pull, self-update on pin move, run installers"
```

---

### Task 17: `init` Command and Scaffold Templates

**Files:**
- Create: `packages/cli/src/commands/init.ts`, `packages/cli/templates/init/package.json`, `packages/cli/templates/init/catalog.yaml`, `packages/cli/templates/init/registry.base.yaml`, `packages/cli/templates/init/tool_catalog.yaml`, `packages/cli/templates/init/skills.list`, `packages/cli/templates/init/agents.base.list`, `packages/cli/templates/init/overlays/00-example.md`, `packages/cli/templates/init/gitignore`, `packages/cli/templates/init/env.credentials.example`, `packages/cli/templates/init/docker-compose.override.yml`, `packages/cli/templates/init/README.md`
- Test: `packages/cli/src/commands/init.test.ts`

**Interfaces:**
- Consumes: `templatesDir` (Task 11), `Reporter`.
- Produces:

```ts
export function runInit(deps: { targetDir: string; version: string; reporter: Reporter }): number;
```

Behavior (D35): copy `templates/init/*` into `targetDir`, substituting `{{WAGGLEBOT_VERSION}}` in `package.json` and `README.md` with `deps.version`. Rename `gitignore` → `.gitignore` and `env.credentials.example` → `.env.credentials.example` (npm strips dotfiles from packages, so they ship without the dot). Refuse a target directory that contains anything besides `.git` — report `failed` naming the first offending entry, return 1. Report one `installed` line per file.

Scaffold file contents:

`templates/init/package.json`:

```json
{
  "name": "company-wagglebot",
  "private": true,
  "dependencies": { "wagglebot": "{{WAGGLEBOT_VERSION}}" },
  "scripts": { "update:wagglebot": "wagglebot update" }
}
```

`templates/init/catalog.yaml` — the four-entity example from the contracts spec (Domain `payments`, System `payments-platform`, Group `team-payments`, Users `alice` with the org-owner annotation and `bob`), each line commented with `# EDIT:` guidance at the top:

```yaml
# EDIT: replace every example entity with your own organization.
# The catalog is authoritative. An unknown value is a hard error (D20, D27).
apiVersion: backstage.io/v1alpha1
kind: Domain
metadata:
  name: payments
spec:
  owner: team-payments
---
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: payments-platform
spec:
  owner: team-payments
  domain: payments
---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: team-payments
spec:
  type: team
  members: [alice, bob]
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: alice
  annotations:
    wagglebot.dev/org-owner: "true"
spec:
  memberOf: [team-payments]
---
apiVersion: backstage.io/v1alpha1
kind: User
metadata:
  name: bob
spec:
  memberOf: [team-payments]
```

`templates/init/registry.base.yaml`:

```yaml
# MCP upstreams for every team. The registry never carries a secret (D10).
# Credentials: the entry names an environment variable; the value lives in
# the gitignored .env.credentials file on each workstation.
proxies: []
# Example:
# proxies:
#   - namespace: example
#     mode: remote_http
#     endpoint: https://mcp.example.com/mcp
#     auth:
#       scheme: { kind: bearer }
#       source: { from: env, var: EXAMPLE_TOKEN }
```

`templates/init/tool_catalog.yaml`:

```yaml
# Routing advice for the Phase 2 hub. Optional in Phase 1.
version: 1
title: Company tool catalog
families: []
```

`templates/init/skills.list` (seed from the phase 1 spec; the pins are placeholders that the validation warning surfaces until the company replaces them — every seed entry is third-party, so every seed entry must pin):

```
# Curated skill packages. One pinned entry per line: owner/repo@<tag-or-commit>.
# A third-party entry MUST pin (D32). Replace <pin-me> with a real tag or commit.
# obra/superpowers@<pin-me>
# ayghri/i-have-adhd@<pin-me>
# wagglebot/skills@<pin-me>        # first-party, D33
```

`templates/init/agents.base.list`:

```
# Shared custom agents, one owner/repo[@ref] per line (D31, D32).
# A component agent needs no entry here: .agents/subagents/ travels with its repository.
# Example:
# acme/review-agents@1a2b3c4
```

`templates/init/overlays/00-example.md`:

```markdown
## Company Overlay Example

Overlays extend AGENTS.base.md by concatenation. Add one file per topic.
Put workstation and team specifics here, never in the base template.
```

`templates/init/gitignore`:

```
node_modules/
.env.credentials
```

`templates/init/env.credentials.example`:

```
# Copy to .env.credentials (gitignored). One line per credential that
# registry entries name. Values never leave this machine (D10).
# EXAMPLE_TOKEN=
```

`templates/init/docker-compose.override.yml`:

```yaml
# Phase 2 deployment choices land here. Phase 1 runs no service (D14).
services: {}
```

`templates/init/README.md`:

```markdown
# Company Agent Environment

Provisioned by [wagglebot](https://github.com/swiknaba/wagglebot) {{WAGGLEBOT_VERSION}}.

## Setup

1. Run `git clone <this repo>`.
2. Run `yarn install`.
3. Run `yarn update:wagglebot`.

The last command provisions this workstation: skills, subagents, base
prompts, and MCP configs, in every agent harness. Run it again after
each merge to this repository.

## Credentials

Copy `.env.credentials.example` to `.env.credentials` and fill the
values. The file is gitignored. No credential ever enters this
repository.

## Upgrade

Bump the `wagglebot` pin in `package.json` in a pull request. Review
the wagglebot changelog for base-template changes.
```

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runInit } from "./init";

const quiet = () => createReporter(() => {}, false);

test("scaffolds the company repository with the version substituted", () => {
  const target = mkdtempSync(join(tmpdir(), "wgl-init-"));
  mkdirSync(join(target, ".git")); // a fresh clone is allowed
  const code = runInit({ targetDir: target, version: "1.4.2", reporter: quiet() });
  expect(code).toBe(0);
  const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  expect(pkg.dependencies.wagglebot).toBe("1.4.2");
  expect(pkg.scripts["update:wagglebot"]).toBe("wagglebot update");
  for (const f of ["catalog.yaml", "registry.base.yaml", "tool_catalog.yaml", "skills.list", "agents.base.list", ".gitignore", ".env.credentials.example", "docker-compose.override.yml", "README.md", "overlays/00-example.md"]) {
    expect(existsSync(join(target, f))).toBe(true);
  }
  expect(readFileSync(join(target, ".gitignore"), "utf8")).toContain(".env.credentials");
});

test("refuses a non-empty directory", () => {
  const target = mkdtempSync(join(tmpdir(), "wgl-init-"));
  writeFileSync(join(target, "existing.txt"), "x");
  const r = createReporter(() => {}, false);
  expect(runInit({ targetDir: target, version: "1.4.2", reporter: r })).toBe(1);
  expect(r.failed()).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/init.test.ts` — expected: FAIL.

- [ ] **Step 3: Create the template files and implement**

Write all eleven `templates/init/` files with the contents above, then:

```ts
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templatesDir } from "../harness";
import type { Reporter } from "../report";

const RENAMES: Record<string, string> = { gitignore: ".gitignore", "env.credentials.example": ".env.credentials.example" };
const SUBSTITUTED = new Set(["package.json", "README.md"]);

export function runInit(deps: { targetDir: string; version: string; reporter: Reporter }): number {
  const { targetDir, reporter } = deps;
  reporter.section("Scaffold company repository");
  mkdirSync(targetDir, { recursive: true });
  const offending = readdirSync(targetDir).find((entry) => entry !== ".git");
  if (offending !== undefined) {
    reporter.item(targetDir, "failed", `directory is not empty ("${offending}") — init refuses to overwrite`);
    return 1;
  }
  const source = join(templatesDir(), "init");
  cpSync(source, targetDir, { recursive: true });
  for (const [from, to] of Object.entries(RENAMES)) {
    if (existsSync(join(targetDir, from))) renameSync(join(targetDir, from), join(targetDir, to));
  }
  for (const file of SUBSTITUTED) {
    const path = join(targetDir, file);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("{{WAGGLEBOT_VERSION}}", deps.version));
  }
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
    );
  for (const file of walk(targetDir, "").filter((f) => !f.startsWith(".git/"))) reporter.item(file, "installed");
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/commands/init.test.ts` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/templates/init packages/cli/src/commands/init.ts packages/cli/src/commands/init.test.ts
git commit -m "feat(cli): wagglebot init — scaffold the company repository (D35)"
```

---

### Task 18: CLI Dispatch, `--help`, and Packaging

**Files:**
- Modify: `packages/cli/src/index.ts`, `packages/cli/src/index.test.ts`, `packages/cli/README.md`, `README.md` (root)

**Interfaces:**
- Consumes: every command module.
- Produces: the finished `main` dispatch. Commands: `update` (flags: `--skip-self-update`), `init [dir]`, `install-skills` (`--update`), `install-agents`, `sync-agents` (`--dry-run`, `--restore [path]`), `write-mcp` (`--dry-run`), `--help`, `--version`.

- [ ] **Step 1: Extend the failing test**

Add to `packages/cli/src/index.test.ts`:

```ts
test("--help explains what update touches, file by file", async () => {
  const lines: string[] = [];
  const code = await main(["--help"], { write: (l) => lines.push(l) });
  expect(code).toBe(0);
  const text = lines.join("\n");
  for (const fragment of [
    "update", "init", "install-skills", "install-agents", "sync-agents",
    "~/.claude/CLAUDE.md", "~/.claude/settings.json", "~/.claude.json", "~/.claude/agents/",
    "~/.codex/AGENTS.md", "~/.agents/AGENTS.md",
    "<!-- wagglebot:begin -->", "~/.wagglebot/managed.json", "~/.wagglebot/backups/",
  ]) {
    expect(text).toContain(fragment);
  }
});

test("update --help prints the same help", async () => {
  const lines: string[] = [];
  expect(await main(["update", "--help"], { write: (l) => lines.push(l) })).toBe(0);
  expect(lines.join("\n")).toContain("managed");
});
```

Run: `bun test packages/cli/src/index.test.ts` — expected: FAIL.

- [ ] **Step 2: Implement the dispatch**

Rewrite `src/index.ts`: build the help text **from `HARNESSES`** (one line per target file, so the table and the help never drift), and dispatch with `node:util` `parseArgs`:

```ts
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { realExec } from "./exec";
import { HARNESSES } from "./harness";
import { createReporter } from "./report";
import { findCompanyRoot, loadCompanyRepo } from "./company";
import { runInit } from "./commands/init";
import { runInstallAgents } from "./commands/install-agents";
import { resolveSkillsBin, runInstallSkills } from "./commands/install-skills";
import { runSyncAgents } from "./commands/sync-agents";
import { runUpdate } from "./commands/update";
import { runWriteMcp } from "./commands/write-mcp";
import { loadCatalog, teamsOf } from "./catalog";
import { getUsername } from "./identity";
import { loadRegistry, mergeRegistries } from "./registry";
// helpText(): renders the command list, then per-harness target lines from HARNESSES
// (templateTargets, hooksTarget, mcpTarget, subagentDir, each prefixed "~/"), then the
// managed-block explanation naming "<!-- wagglebot:begin -->", ~/.wagglebot/managed.json,
// and ~/.wagglebot/backups/. Every mutation stays inside a managed block; content outside
// stays untouched.
```

The `update`, `install-*`, `sync-agents`, and `write-mcp` branches wire the real dependencies: `home: homedir()`, `exec: realExec`, `ask` via `readline/promises` (create the interface lazily, close it after one question), `skillsBin: resolveSkillsBin()`, `reporter: createReporter(deps.write)`. `init` resolves `version()` (already in Task 1) and `targetDir` from the positional argument (default `"."`). Standalone `install-agents` and `write-mcp` load the company repo + catalog + identity the same way `runUpdate` does — extract that shared wiring into one local function `companyContext(cwd, exec, ask)` inside `index.ts` returning `{ company, catalog, username, teams }`.

Run: `bun test` — expected: all PASS.

- [ ] **Step 3: Update the READMEs**

`packages/cli/README.md`: replace the placeholder text with: what the package installs, the three-command engineer flow, the command list with one line each, and a pointer to the specs. Root `README.md`: remove the "Status: specification stage / No code exists yet" note; state that Phase 1 is implemented in `packages/cli` and Phases 2–4 stay specification. Keep both READMEs to the STE baseline.

- [ ] **Step 4: Full verification**

Run, in order, and confirm each:

```bash
bun run check && bun run typecheck && bun test && bun run build
node packages/cli/bin/wagglebot.js --help          # prints the file-by-file help
HOME=$(mktemp -d) node packages/cli/bin/wagglebot.js sync-agents --dry-run   # dry run against a scratch home, exits 0
cd "$(mktemp -d)" && node <repo>/packages/cli/bin/wagglebot.js init . && ls  # scaffold appears
```

Also verify success criterion 2 by hand: in a scratch company repo (the `init` output plus `git init && git add -A && git commit`), run `sync-agents` twice against a scratch `HOME` and confirm the second run prints only `already ok` lines.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/index.test.ts packages/cli/README.md README.md
git commit -m "feat(cli): command dispatch, file-by-file --help, README updates"
```

---

## Coverage Notes (spec → task)

| Spec requirement | Task |
|---|---|
| Update command: pull, pin-move reinstall, installers, summary (D34) | 16 |
| `--help` explains file-by-file touches | 18 |
| Idempotent + non-destructive managed blocks (F22) | 5, 6, 12, 13 |
| Stored, validated engineer identity (P35) | 9 |
| MCP configs written per harness, credentials as env names (D10) | 13 |
| Curated skills list + installer, `--update` pin bump | 7, 14 |
| Agent lists + installer, uninstall on removal (D31, D32) | 7, 15 |
| Base template seed sections + overlays concatenation (D35) | 11, 12 |
| Harness target table, chmod 600, counts, missing dirs | 11, 12 |
| Hook fragments merged per entry, foreign hooks preserved | 6, 11, 12 |
| Backups + `--dry-run` + `--restore` | 4, 12 |
| No secret is ever written (F23) | 10 (literal rejected), 13 (env expansions only) |
| `init` scaffold: catalog, registries, lists, overlays, compose override, README (D35) | 17 |
| Catalog validation: duplicates and unknown values are hard errors (D27) | 8 |
| Component memory `.agents/memory.md` (D29) | Memory section of `AGENTS.base.md` (Task 11) — Phase 1 ships instructions, no tooling, per the spec |
| First-party skills content (`wagglebot/skills` repository, D33) | **Out of scope** — a separate repository; the seed `skills.list` references it |

Success criteria 1–5 and 8–10 map to Tasks 12–18 and the Task 18 verification step. Criterion 6 is Tasks 15+16. Criterion 7 and 11 concern skill content and agent behavior, not this CLI.
