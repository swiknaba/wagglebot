# Phase 1 MVP Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps found in the Phase 1 review so a team can test the CLI end to end: credentials reach the harness, the harness table is correct and selectable, the company repository has one consistent folder layout, the skills installer works with the real `skills` CLI, the base prompt describes Phase 1 truthfully, and every command has useful `--help`.

**Architecture:** The CLI keeps its shape: one command module per command under `packages/cli/src/commands/`, pure helper modules under `packages/cli/src/`, one harness table in `harness.ts`, and managed blocks for every mutation. This plan adds harness selection, a shell-environment block, a layered company repository (`company/` plus `teams/<team>/`), and state-based idempotency for skills. No new dependency.

**Tech Stack:** TypeScript on Bun (`bun test`, `bun build`), `node:util` `parseArgs`, `yaml`, the `skills` npm CLI (1.5.23), Biome.

**Spec:** `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md` (Task 9 updates it to match this plan).

## Global Constraints

- Every mutation under `~` lands inside a managed block, and content outside stays untouched (F22). Markdown files use `<!-- wagglebot:begin -->` / `<!-- wagglebot:end -->`. Shell rc files use `# wagglebot:begin` / `# wagglebot:end`. JSON files use per-key ownership recorded in `~/.wagglebot/managed.json`.
- No secret is ever written by the CLI (F23). MCP configs carry `${VAR}` expansions only.
- Idempotent: a second run reports every item as `ok` and changes nothing.
- The `skills` CLI needs Node `>=22.20.0`. Its source syntax for a ref is `owner/repo#<ref>`, and it accepts a tag or a branch, never a commit hash (it clones with `--depth=1 --branch`). Our list format stays `owner/repo@<ref>`, and the installer translates.
- Prose in docs, comments, and help text follows the STE baseline: short sentences, active voice, no contractions.
- Run `bun run check` (Biome) before each commit. The full gate is `bun run check && bun run typecheck && bun test`. Tasks 4, 5, and 6 change module signatures and leave `src/index.ts` and `src/commands/update.ts` red on `typecheck` until Task 8 rewires them. Those tasks run only their own test files.
- Work in `packages/cli/`. Paths below are relative to the repository root unless stated.
- Bun lives at `~/.bun/bin`. Run `export PATH="$HOME/.bun/bin:$PATH"` first. Node 22 is at `~/.nvm/versions/node/v22.15.0/bin/node`.

---

## Wave plan

| Wave | Tasks | Notes |
|---|---|---|
| A | 1, 2, 3, 7 | Independent files. Task 3 also updates callers so the tree stays green. |
| B | 4, 5, 6 | Module-only changes with new signatures. Tree goes red on typecheck until Task 8. |
| C | 8 | Wiring, help, `update` flow. Restores the full gate. |
| D | 9 | Docs, spec, CI, e2e, regenerate `test-app/`. |

---

### Task 1: Harness table and harness selection

**Files:**
- Modify: `packages/cli/src/harness.ts`
- Modify: `packages/cli/src/harness.test.ts`
- Create: `packages/cli/src/harness-select.ts`
- Create: `packages/cli/src/harness-select.test.ts`

**Interfaces:**
- Produces: `Harness` gains `detectDir: string` and `skillsAgent?: string`. `HARNESSES` has six entries: `claude-code`, `codex`, `junie`, `cline`, `gemini`, `copilot`. `selectHarnesses(home: string, exec: Exec): Promise<{ harnesses: Harness[]; source: "config" | "detected" }>` and `HARNESS_CONFIG_KEY = "wagglebot.harnesses"`.

Verified paths (vendor docs, 2026-09-02): Codex reads `~/.codex/AGENTS.md`. Junie reads `~/.junie/AGENTS.md` and Markdown subagents from `~/.junie/agents/`. Cline reads every `.md` file in `~/.cline/rules/`. Gemini CLI reads `~/.gemini/GEMINI.md`. GitHub Copilot CLI reads `~/.copilot/copilot-instructions.md`. The agents.md standard is project-level only, so `~/.agents/AGENTS.md` is dropped. Codex subagents are TOML, so Codex has no `subagentDir`.

- [ ] **Step 1: Replace the harness table**

Rewrite the `Harness` type and `HARNESSES` in `packages/cli/src/harness.ts`. Keep `templatesDir()` unchanged.

```ts
export type Harness = {
  name: string;
  // Home-relative directory whose presence means the harness is installed on this machine.
  detectDir: string;
  // The --agent id the skills CLI uses for this harness. Undefined: the skills CLI has no adapter.
  skillsAgent?: string;
  // Global instruction files. The rendered base prompt lands in a managed block in each one.
  templateTargets: string[];
  // Settings file that holds hook definitions, plus the fragment in templates/hooks/ to merge.
  hooksTarget?: { path: string; fragmentFile: string };
  // Config file and the key under which MCP servers are declared.
  mcpTarget?: { path: string; parentKey: string };
  // Directory the harness reads Markdown subagents from. Undefined: no known Markdown format.
  subagentDir?: string;
};

// Paths verified against vendor documentation on 2026-09-02. Codex subagents are TOML, not
// Markdown, so Codex has no subagentDir. Cline reads every .md file in its rules directory,
// so wagglebot owns one file there instead of a block in a shared file.
export const HARNESSES: Harness[] = [
  {
    name: "claude-code",
    detectDir: ".claude",
    skillsAgent: "claude-code",
    templateTargets: [".claude/CLAUDE.md"],
    hooksTarget: { path: ".claude/settings.json", fragmentFile: "claude-code.json" },
    mcpTarget: { path: ".claude.json", parentKey: "mcpServers" },
    subagentDir: ".claude/agents",
  },
  { name: "codex", detectDir: ".codex", skillsAgent: "codex", templateTargets: [".codex/AGENTS.md"] },
  {
    name: "junie",
    detectDir: ".junie",
    skillsAgent: "junie",
    templateTargets: [".junie/AGENTS.md"],
    subagentDir: ".junie/agents",
  },
  { name: "cline", detectDir: ".cline", skillsAgent: "cline", templateTargets: [".cline/rules/wagglebot.md"] },
  { name: "gemini", detectDir: ".gemini", skillsAgent: "gemini-cli", templateTargets: [".gemini/GEMINI.md"] },
  {
    name: "copilot",
    detectDir: ".copilot",
    skillsAgent: "github-copilot",
    templateTargets: [".copilot/copilot-instructions.md"],
  },
];
```

Check the Junie id: open `node_modules/.bun/skills@1.5.23/node_modules/skills/README.md`, find the "Supported Agents" table, and copy the `--agent` id of the Junie row. If the table has no Junie row, set `skillsAgent` to `undefined` for junie and add a comment.

- [ ] **Step 2: Update the table test**

Replace the first test in `packages/cli/src/harness.test.ts`:

```ts
test("the harness table carries the verified targets", () => {
  expect(HARNESSES.map((h) => h.name)).toEqual(["claude-code", "codex", "junie", "cline", "gemini", "copilot"]);
  const claude = HARNESSES[0];
  expect(claude?.templateTargets).toEqual([".claude/CLAUDE.md"]);
  expect(claude?.mcpTarget).toEqual({ path: ".claude.json", parentKey: "mcpServers" });
  expect(claude?.subagentDir).toBe(".claude/agents");
  expect(HARNESSES.find((h) => h.name === "gemini")?.templateTargets).toEqual([".gemini/GEMINI.md"]);
  expect(HARNESSES.find((h) => h.name === "junie")?.subagentDir).toBe(".junie/agents");
  expect(HARNESSES.filter((h) => h.hooksTarget !== undefined)).toHaveLength(1);
  for (const h of HARNESSES) expect(h.detectDir.startsWith(".")).toBe(true);
});
```

Run: `bun test src/harness.test.ts` — expected: PASS.

- [ ] **Step 3: Write the failing selection tests**

Create `packages/cli/src/harness-select.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec";
import { selectHarnesses } from "./harness-select";

const home = () => mkdtempSync(join(tmpdir(), "wgl-sel-"));
const configExec =
  (value: string): Exec =>
  async () => ({ code: value === "" ? 1 : 0, stdout: value, stderr: "" });

test("detects installed harnesses by their home directory, in table order", async () => {
  const h = home();
  mkdirSync(join(h, ".gemini"));
  mkdirSync(join(h, ".claude"));
  const result = await selectHarnesses(h, configExec(""));
  expect(result.source).toBe("detected");
  expect(result.harnesses.map((x) => x.name)).toEqual(["claude-code", "gemini"]);
});

test("git config wagglebot.harnesses overrides detection", async () => {
  const h = home();
  mkdirSync(join(h, ".claude"));
  const result = await selectHarnesses(h, configExec("codex, junie\n"));
  expect(result.source).toBe("config");
  expect(result.harnesses.map((x) => x.name)).toEqual(["codex", "junie"]);
});

test("an unknown name in the config is a hard error that lists the valid names", async () => {
  await expect(selectHarnesses(home(), configExec("cursor"))).rejects.toThrow(/cursor.*claude-code/s);
});

test("no detected harness is a hard error with the config hint", async () => {
  await expect(selectHarnesses(home(), configExec(""))).rejects.toThrow(/wagglebot\.harnesses/);
});
```

Run: `bun test src/harness-select.test.ts` — expected: FAIL, module not found.

- [ ] **Step 4: Implement selection**

Create `packages/cli/src/harness-select.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec";
import { type Harness, HARNESSES } from "./harness";

export const HARNESS_CONFIG_KEY = "wagglebot.harnesses";

const valid = () => HARNESSES.map((h) => h.name).join(", ");

// Which harnesses this workstation provisions. An explicit list in the global git config wins.
// Otherwise every harness whose home directory exists is selected, so a machine without
// Junie never gets a ~/.junie directory.
export async function selectHarnesses(
  home: string,
  exec: Exec,
): Promise<{ harnesses: Harness[]; source: "config" | "detected" }> {
  const stored = await exec("git", ["config", "--global", HARNESS_CONFIG_KEY]);
  const names = stored.stdout
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  if (names.length > 0) {
    const unknown = names.filter((n) => !HARNESSES.some((h) => h.name === n));
    if (unknown.length > 0) {
      throw new Error(
        `git config ${HARNESS_CONFIG_KEY} names an unknown harness "${unknown[0]}". Valid names: ${valid()}.`,
      );
    }
    return { harnesses: HARNESSES.filter((h) => names.includes(h.name)), source: "config" };
  }
  const detected = HARNESSES.filter((h) => existsSync(join(home, h.detectDir)));
  if (detected.length === 0) {
    throw new Error(
      `no agent harness found under ${home}. Install one, or choose explicitly: git config --global ${HARNESS_CONFIG_KEY} claude-code,codex (valid names: ${valid()}).`,
    );
  }
  return { harnesses: detected, source: "detected" };
}
```

Run: `bun test src/harness-select.test.ts src/harness.test.ts` — expected: PASS.

- [ ] **Step 5: Check the other tests still pass and commit**

Run: `bun run check && bun run typecheck && bun test`. Tests that assert the old paths (`.gemini/config/rules/global.md`, `agents-standard`) fail: update them to `.gemini/GEMINI.md` and the new name list. Expected after the fix: all PASS.

```bash
git add packages/cli/src/harness.ts packages/cli/src/harness.test.ts packages/cli/src/harness-select.ts packages/cli/src/harness-select.test.ts packages/cli/src/commands/*.test.ts packages/cli/e2e/provisioning.test.ts
git commit -m "feat(cli): verified harness table, harness selection by detection or git config"
```

---

### Task 2: Shell environment block and `sync-shell`

**Files:**
- Modify: `packages/cli/src/managed-block.ts`
- Modify: `packages/cli/src/managed-block.test.ts`
- Create: `packages/cli/templates/shell/wagglebot.sh`
- Create: `packages/cli/src/commands/sync-shell.ts`
- Create: `packages/cli/src/commands/sync-shell.test.ts`

**Interfaces:**
- Produces: `renderManagedBlock(existing, content, style?: "html" | "hash")` (default `"html"`, so every existing caller stays valid). `runSyncShell(deps: { home: string; companyRoot: string; reporter: Reporter; backups?: BackupSet }): number`. `SHELL_RC_FILES`.

The block in the rc file only sets one variable and sources one script that ships inside the wagglebot package. A pin bump therefore updates the script, and the rc file never changes again. `~/.zshenv` is always written, because zsh reads it for every shell, interactive or not, so IDE terminals and agent subprocesses get the variables. `~/.bashrc` is written only when it already exists, so a zsh-only Mac gets no new bash file.

- [ ] **Step 1: Write the failing marker-style test**

Append to `packages/cli/src/managed-block.test.ts`:

```ts
test("hash style uses shell comment markers", () => {
  const { next } = renderManagedBlock("export A=1\n", "export B=2", "hash");
  expect(next).toBe("export A=1\n# wagglebot:begin\nexport B=2\n# wagglebot:end\n");
  expect(renderManagedBlock(next, "export B=2", "hash").changed).toBe(false);
});
```

Run: `bun test src/managed-block.test.ts` — expected: FAIL (argument count).

- [ ] **Step 2: Add the style parameter**

Rewrite `packages/cli/src/managed-block.ts`:

```ts
export type MarkerStyle = "html" | "hash";
const MARKERS: Record<MarkerStyle, { begin: string; end: string }> = {
  html: { begin: "<!-- wagglebot:begin -->", end: "<!-- wagglebot:end -->" },
  hash: { begin: "# wagglebot:begin", end: "# wagglebot:end" },
};
export const BLOCK_BEGIN = MARKERS.html.begin;
export const BLOCK_END = MARKERS.html.end;

export function renderManagedBlock(
  existing: string,
  content: string,
  style: MarkerStyle = "html",
): { next: string; changed: boolean } {
  const { begin: BEGIN, end: END } = MARKERS[style];
  const begin = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  const rendered = `${BEGIN}\n${content}\n${END}`;
  if (begin === -1 && end === -1) {
    const sep = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { next: `${existing}${sep}${rendered}\n`, changed: true };
  }
  if (begin === -1) throw new Error("managed block: found the end marker without a begin marker");
  if (end === -1) throw new Error("managed block: found the begin marker without an end marker");
  if (end < begin) throw new Error("managed block: the end marker appears before the begin marker");
  const next = existing.slice(0, begin) + rendered + existing.slice(end + END.length);
  return { next, changed: next !== existing };
}
```

Run: `bun test src/managed-block.test.ts` — expected: PASS.

- [ ] **Step 3: Create the shipped shell script**

Create `packages/cli/templates/shell/wagglebot.sh`:

```sh
# wagglebot shell environment.
#
# The managed block in ~/.zshenv (and ~/.bashrc, when that file exists) sources this file.
# It exports every line of the gitignored .env.credentials file of the company repository,
# so an agent harness started from this shell can expand ${VAR} in its MCP config.
#
# Do not edit this file. A wagglebot upgrade replaces it. Company changes belong in the
# company repository.
if [ -n "${WAGGLEBOT_COMPANY_REPO:-}" ] && [ -r "$WAGGLEBOT_COMPANY_REPO/.env.credentials" ]; then
  set -a
  . "$WAGGLEBOT_COMPANY_REPO/.env.credentials"
  set +a
fi
```

Check `packages/cli/package.json` `files`: `templates/` is already listed, so the script ships.

- [ ] **Step 4: Write the failing sync-shell tests**

Create `packages/cli/src/commands/sync-shell.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runSyncShell } from "./sync-shell";

const quiet = () => createReporter(() => {}, false);
const home = () => mkdtempSync(join(tmpdir(), "wgl-shell-"));

test("writes a hash-marker block to .zshenv and leaves a missing .bashrc alone", () => {
  const h = home();
  expect(runSyncShell({ home: h, companyRoot: "/srv/company", reporter: quiet() })).toBe(0);
  const zshenv = readFileSync(join(h, ".zshenv"), "utf8");
  expect(zshenv).toContain("# wagglebot:begin");
  expect(zshenv).toContain('export WAGGLEBOT_COMPANY_REPO="/srv/company"');
  expect(zshenv).toContain("node_modules/wagglebot/templates/shell/wagglebot.sh");
  expect(existsSync(join(h, ".bashrc"))).toBe(false);
});

test("an existing .bashrc gets the block and keeps its content; second run is ok", () => {
  const h = home();
  writeFileSync(join(h, ".bashrc"), "alias ll='ls -l'\n");
  runSyncShell({ home: h, companyRoot: "/srv/company", reporter: quiet() });
  const bashrc = readFileSync(join(h, ".bashrc"), "utf8");
  expect(bashrc.startsWith("alias ll='ls -l'\n")).toBe(true);
  expect(bashrc).toContain("# wagglebot:end");
  const r = createReporter(() => {}, false);
  expect(runSyncShell({ home: h, companyRoot: "/srv/company", reporter: r })).toBe(0);
  expect(r.counts()).toMatchObject({ ok: 2, updated: 0 });
});

test("a moved company repository rewrites the block", () => {
  const h = home();
  runSyncShell({ home: h, companyRoot: "/old", reporter: quiet() });
  const r = createReporter(() => {}, false);
  runSyncShell({ home: h, companyRoot: "/new", reporter: r });
  expect(r.counts().updated).toBe(1);
  expect(readFileSync(join(h, ".zshenv"), "utf8")).not.toContain("/old");
});
```

Run: `bun test src/commands/sync-shell.test.ts` — expected: FAIL, module not found.

- [ ] **Step 5: Implement sync-shell**

Create `packages/cli/src/commands/sync-shell.ts`:

```ts
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
```

Run: `bun test src/commands/sync-shell.test.ts src/managed-block.test.ts` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run check
git add packages/cli/src/managed-block.ts packages/cli/src/managed-block.test.ts packages/cli/templates/shell/wagglebot.sh packages/cli/src/commands/sync-shell.ts packages/cli/src/commands/sync-shell.test.ts
git commit -m "feat(cli): shell environment block that loads .env.credentials from the company repo"
```

---

### Task 3: Layered company repository (`company/` and `teams/<team>/`)

**Files:**
- Modify: `packages/cli/src/company.ts`
- Modify: `packages/cli/src/company.test.ts`
- Modify: `packages/cli/src/index.ts` (callers only)
- Modify: `packages/cli/src/commands/update.ts` (callers only)
- Modify: `packages/cli/src/commands/update.test.ts` (scaffold helper paths)
- Move and edit files under `packages/cli/templates/init/`
- Modify: `packages/cli/src/commands/init.test.ts`

**Interfaces:**
- Produces:

```ts
export type Layer = {
  name: string;            // "company", or the team directory name (equals the Group name)
  dir: string;             // absolute path of the layer directory
  catalogText?: string;    // <dir>/catalog.yaml
  registryText?: string;   // <dir>/registry.yaml
  skillsListText?: string; // <dir>/skills.list
  agentsListText?: string; // <dir>/agents.list
  agentsDir: string;       // <dir>/agents  (may not exist)
  instructionsDir: string; // <dir>/instructions  (may not exist)
};
export type CompanyRepo = {
  root: string;
  pin: string;
  company: Layer;
  teams: Layer[];          // one per teams/<name>/ directory, sorted by name
  catalogText: string;     // every catalog.yaml joined with "\n---\n"
  catalogPath: string;     // label for error messages
  layersFor(teamNames: string[]): Layer[]; // [company, ...teams with a matching name], in that order
};
export function findCompanyRoot(cwd: string): string;          // unchanged
export function loadCompanyRepo(root: string): CompanyRepo;
export function assertTeamDirsKnown(company: CompanyRepo, groupNames: string[]): void; // throws on teams/<x> with no Group x
```

New layout of a company repository:

```
package.json  README.md  .gitignore  .nvmrc  .env.credentials.example  tool_catalog.yaml  docker-compose.override.yml
company/
  catalog.yaml        (optional) entities shared by everyone
  registry.yaml       MCP servers for everyone
  skills.list         curated skills for everyone
  agents.list         shared subagents from other repositories, for everyone
  agents/*.md         company subagents
  instructions/*.md   company instructions
teams/<team>/         same six items, for the members of Group <team>
  catalog.yaml        the Group, its Users, its Domains and Systems
  registry.yaml  skills.list  agents.list  agents/  instructions/
```

The old flat files (`catalog.yaml`, `catalogs/`, `registry.base.yaml`, `registry.team.<t>.yaml`, `skills.list`, `agents.base.list`, `agents.team.<t>.list`, `instructions/`, `agents/`) are no longer read. There is no user of the old layout, so there is no compatibility path.

- [ ] **Step 1: Rewrite the company tests**

Replace `packages/cli/src/company.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTeamDirsKnown, findCompanyRoot, loadCompanyRepo } from "./company";

const user = (name: string) => `kind: User\nmetadata: { name: ${name} }\nspec: { memberOf: [] }\n`;

const scaffold = () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-co-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.4.2" } }));
  mkdirSync(join(root, "company/instructions"), { recursive: true });
  writeFileSync(join(root, "company/registry.yaml"), "proxies: []\n");
  writeFileSync(join(root, "company/skills.list"), "");
  mkdirSync(join(root, "teams/payments"), { recursive: true });
  writeFileSync(join(root, "teams/payments/catalog.yaml"), user("alice"));
  writeFileSync(join(root, "teams/payments/registry.yaml"), "proxies: []\n");
  mkdirSync(join(root, "teams/search"), { recursive: true });
  writeFileSync(join(root, "teams/search/catalog.yaml"), user("bob"));
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

test("merges every catalog.yaml and exposes one layer per team directory", () => {
  const company = loadCompanyRepo(scaffold());
  expect(company.teams.map((t) => t.name)).toEqual(["payments", "search"]);
  expect(company.catalogText).toContain("alice");
  expect(company.catalogText).toContain("bob");
  expect(company.company.registryText).toBe("proxies: []\n");
  expect(company.company.skillsListText).toBe("");
  expect(company.teams[0]?.registryText).toBe("proxies: []\n");
  expect(company.teams[1]?.registryText).toBeUndefined();
});

test("layersFor returns the company layer first, then the named teams in order", () => {
  const company = loadCompanyRepo(scaffold());
  expect(company.layersFor(["search"]).map((l) => l.name)).toEqual(["company", "search"]);
  expect(company.layersFor(["search", "payments"]).map((l) => l.name)).toEqual(["company", "payments", "search"]);
  expect(company.layersFor(["nobody"]).map((l) => l.name)).toEqual(["company"]);
});

test("a repository without any catalog.yaml throws", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-nocat-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.4.2" } }));
  mkdirSync(join(root, "company"));
  expect(() => loadCompanyRepo(root)).toThrow(/catalog\.yaml/);
});

test("a teams/ directory that matches no Group is a hard error", () => {
  const company = loadCompanyRepo(scaffold());
  expect(() => assertTeamDirsKnown(company, ["payments"])).toThrow(/teams\/search/);
  expect(() => assertTeamDirsKnown(company, ["payments", "search"])).not.toThrow();
});
```

Run: `bun test src/company.test.ts` — expected: FAIL.

- [ ] **Step 2: Rewrite company.ts**

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Layer = {
  name: string;
  dir: string;
  catalogText?: string;
  registryText?: string;
  skillsListText?: string;
  agentsListText?: string;
  agentsDir: string;
  instructionsDir: string;
};

export type CompanyRepo = {
  root: string;
  pin: string;
  company: Layer;
  teams: Layer[];
  catalogText: string;
  catalogPath: string;
  layersFor: (teamNames: string[]) => Layer[];
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
        `no company repository found above ${cwd}. Run this command inside the repository scaffolded by "wagglebot init" — its package.json pins the "wagglebot" dependency.`,
      );
    }
    dir = parent;
  }
}

// company/ and every teams/<team>/ directory share one shape. A team directory is named
// after its Group, so a member of Group "payments" gets the layer teams/payments/.
const readLayer = (name: string, dir: string): Layer => ({
  name,
  dir,
  catalogText: readOptional(join(dir, "catalog.yaml")),
  registryText: readOptional(join(dir, "registry.yaml")),
  skillsListText: readOptional(join(dir, "skills.list")),
  agentsListText: readOptional(join(dir, "agents.list")),
  agentsDir: join(dir, "agents"),
  instructionsDir: join(dir, "instructions"),
});

export function loadCompanyRepo(root: string): CompanyRepo {
  const pin = pinOf(root);
  if (pin === undefined) throw new Error(`${root}/package.json does not pin the "wagglebot" dependency`);
  const company = readLayer("company", join(root, "company"));
  const teamsDir = join(root, "teams");
  const teams = existsSync(teamsDir)
    ? readdirSync(teamsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .map((name) => readLayer(name, join(teamsDir, name)))
    : [];
  const catalogs = [company, ...teams].filter((l) => l.catalogText !== undefined);
  if (catalogs.length === 0) {
    throw new Error(
      `${root} has no catalog — add teams/<team>/catalog.yaml for each team (and optionally company/catalog.yaml)`,
    );
  }
  return {
    root,
    pin,
    company,
    teams,
    catalogText: catalogs.map((l) => l.catalogText ?? "").join("\n---\n"),
    catalogPath: catalogs.map((l) => join(l.dir, "catalog.yaml")).join(", "),
    layersFor: (teamNames) => [company, ...teams.filter((t) => teamNames.includes(t.name))],
  };
}

// The catalog is the single source of truth (D20, D27). A team directory with no Group
// behind it would silently apply to nobody, so it is a hard error.
export function assertTeamDirsKnown(company: CompanyRepo, groupNames: string[]): void {
  for (const team of company.teams) {
    if (!groupNames.includes(team.name)) {
      throw new Error(
        `teams/${team.name} matches no Group in the catalog — name the directory after the Group, or add the Group to ${join(team.dir, "catalog.yaml")}`,
      );
    }
  }
}
```

Run: `bun test src/company.test.ts` — expected: PASS.

- [ ] **Step 3: Update the callers so the tree compiles**

In `packages/cli/src/index.ts` and `packages/cli/src/commands/update.ts`, replace every use of the removed fields:

- `company.registryBaseText` / `company.registryTeamText(team)` → fold the layers:

```ts
const proxies = company
  .layersFor(teams)
  .filter((l) => l.registryText !== undefined)
  .reduce<ProxyConfig[]>(
    (acc, l) => mergeRegistries(acc, loadRegistry(l.registryText ?? "", `${l.name}/registry.yaml`)),
    [],
  );
```

  Import `ProxyConfig` from `../registry` (type import).
- `company.skillsListText` → `company.company.skillsListText`, and `join(root, "skills.list")` → `join(company.company.dir, "skills.list")`.
- `company.agentListTexts(teams)` → `company.layersFor(teams).flatMap((l) => l.agentsListText === undefined ? [] : [{ path: \`${l.name}/agents.list\`, text: l.agentsListText }])`.
- `company.agentsDir` → `company.company.agentsDir`.
- `company.instructionsDir` → `company.company.instructionsDir`.
- After `loadCatalog(...)` in both `companyContext` (index.ts) and `runUpdate`, add `assertTeamDirsKnown(company, catalog.groups.map((g) => g.name));`.

Update the scaffold helper in `packages/cli/src/commands/update.test.ts` to the new layout: write `company/registry.yaml`, `company/skills.list`, and `teams/<team>/catalog.yaml` instead of the old root files (read the file to find its helper). Group names in that catalog must equal the team directory names.

Run: `bun run typecheck && bun test` — expected: PASS.

- [ ] **Step 4: Move the scaffold templates**

Under `packages/cli/templates/init/`:

```bash
cd packages/cli/templates/init
mkdir -p company teams/team-payments
git mv registry.base.yaml company/registry.yaml
git mv skills.list company/skills.list
git mv agents.base.list company/agents.list
git mv agents company/agents
git mv instructions company/instructions
git mv catalogs/team-payments.yaml teams/team-payments/catalog.yaml
rmdir catalogs
```

Edit the comment headers so every path matches the new layout:

- `company/registry.yaml`: first line `# MCP servers for every team. This file never contains a secret.` Add a second comment: `# A team adds its own servers in teams/<team>/registry.yaml. A team entry with the same namespace wins.`
- `company/agents.list`: replace `agents.base.list` with `company/agents.list`, `agents/` with `company/agents/`, and add `#   - A subagent for one team is committed to teams/<team>/agents/.`
- `company/agents/README.md`: replace `agents.base.list` with `company/agents.list`; replace the sentence about `.agents/subagents/` to also name `teams/<team>/agents/` for one team.
- `company/instructions/00-example.md`: add the sentence `Files in teams/<team>/instructions/ are appended after these, for the members of that team.`
- `teams/team-payments/catalog.yaml`: replace the four leading comment lines with:

```yaml
# EDIT: replace every example entity with your own organization.
# One directory per team lives in teams/. The directory name must equal the Group name.
# wagglebot merges every catalog.yaml (company/ and teams/*/) into one catalog.
# The catalog is the single source of truth. An unknown name is a hard error.
# Every engineer needs a User entity here before the first `wagglebot update`.
```

- `company/skills.list`: replace the whole file with:

```
# Curated skill packages, one per line. The skills CLI installs each entry into every
# selected harness.
#
# "owner/repo" resolves against github.com. Pin each entry: owner/repo@<tag>. The skills
# CLI checks out a tag or a branch, never a commit hash. Pin every repository that the
# company does not control.
#
# For a different git host, use a full URL, then a space and the ref:
#   https://git.my-company.local/platform/skills.git v1.2.0
#
# A team adds its own entries in teams/<team>/skills.list.
obra/superpowers@v6.3.0
ayghri/i-have-adhd@main    # this repository has no tag yet; replace with a tag when one exists
# wagglebot/skills@<pin-me>   # first-party skills, not published yet
```

Create `teams/team-payments/README.md`:

```markdown
# Team team-payments

Everything in this directory applies to the members of the Group `team-payments` only.
The directory name must equal the Group name in `catalog.yaml`.

| File | Purpose |
|---|---|
| `catalog.yaml` | The Group, its Users, and the Domains and Systems it owns. Required. |
| `registry.yaml` | MCP servers for this team. Same format as `company/registry.yaml`. |
| `skills.list` | Skills for this team. Same format as `company/skills.list`. |
| `agents.list` | Shared subagents from other repositories. Same format as `company/agents.list`. |
| `agents/*.md` | Subagents for this team. |
| `instructions/*.md` | Instructions appended after the company instructions. |

Every file except `catalog.yaml` is optional.
```

- [ ] **Step 5: Update the init test and the reference app**

In `packages/cli/src/commands/init.test.ts`, replace the asserted file names with the new paths (`company/registry.yaml`, `company/skills.list`, `teams/team-payments/catalog.yaml`, ...). Then regenerate `test-app/`:

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run regen:test-app
```

Run: `bun run check && bun run typecheck && bun test` — expected: PASS (the scaffold drift e2e passes after regen).

- [ ] **Step 6: Commit**

```bash
git add -A packages/cli/src/company.ts packages/cli/src/company.test.ts packages/cli/src/index.ts packages/cli/src/commands/update.ts packages/cli/src/commands/update.test.ts packages/cli/src/commands/init.test.ts packages/cli/templates/init test-app
git commit -m "feat(cli): layered company repository — company/ and teams/<team>/ share one shape"
```

---

### Task 4: Skills installer that works with the real `skills` CLI

**Files:**
- Modify: `packages/cli/src/state.ts`, `packages/cli/src/state.test.ts`
- Rewrite: `packages/cli/src/commands/install-skills.ts`
- Rewrite: `packages/cli/src/commands/install-skills.test.ts`

**Interfaces:**
- Consumes: `parseList` from `../lists` (`ListEntry = { repo; ref?; raw; isUrl? }`), `loadState`/`saveState`.
- Produces: `ManagedState.skills: Record<string, string[]>` (list entry `raw` → sorted skills agents it was installed for).

```ts
export const SKILLS_NODE_FLOOR = "22.20.0";
export function toSkillsSource(entry: ListEntry): string; // owner/repo#ref, or <url>#ref
export function nodeSatisfies(version: string, floor: string): boolean; // "v22.15.0" vs "22.20.0"
export async function runInstallSkills(deps: {
  lists: { path: string; text: string }[];
  exec: Exec;
  reporter: Reporter;
  skillsBin: string;
  skillsAgents: string[];      // from the selected harnesses; empty → one skipped line
  managedFile: string;         // ~/.wagglebot/managed.json
  nodeVersion?: string;        // default process.version
  update?: boolean;
  writeList?: (path: string, text: string) => void;
}): Promise<number>;
```

Facts, verified on 2026-09-02 with skills 1.5.23: `skills add owner/repo@x` treats `x` as a skill name filter and fails with "No matching skills found". The ref goes after `#`. A 40-hex ref fails with "Failed to clone repository". A second `skills add` of the same source re-installs and prints "Installed N skills", never "already". The CLI prints "Installation failed" on failure. `-a <id>` may be repeated. The CLI throws `SyntaxError ... 'crc32'` on Node 20.

- [ ] **Step 1: Extend the state**

In `packages/cli/src/state.ts`, add `skills: Record<string, string[]>` to `ManagedState` and `EMPTY`, parse it in `loadState` with the same `toJsonKeys` helper (rename the helper to `toStringArrayRecord`), and keep the file backward compatible (a missing key → `{}`). Add to `state.test.ts`:

```ts
test("skills default to an empty record and round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "wgl-state-"));
  const file = join(dir, "managed.json");
  expect(loadState(file).skills).toEqual({});
  saveState(file, { jsonKeys: {}, agentFiles: [], skills: { "a/b@v1": ["claude-code"] } });
  expect(loadState(file).skills).toEqual({ "a/b@v1": ["claude-code"] });
});
```

Run: `bun test src/state.test.ts` — expected: PASS after the change.

- [ ] **Step 2: Write the failing installer tests**

Replace `packages/cli/src/commands/install-skills.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec";
import { parseList } from "../lists";
import { createReporter } from "../report";
import { loadState } from "../state";
import { nodeSatisfies, runInstallSkills, toSkillsSource } from "./install-skills";

const quiet = () => createReporter(() => {}, false);
const managed = () => join(mkdtempSync(join(tmpdir(), "wgl-sk-")), "managed.json");
const NODE = "v24.0.0";

const fakeExec =
  (calls: string[][]): Exec =>
  async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "fail/fail#v1") return { code: 1, stdout: "■ Installation failed", stderr: "" };
    return { code: 0, stdout: "Installed 3 skills", stderr: "" };
  };

test("translates our @ref format into the skills CLI #ref format", () => {
  expect(toSkillsSource(parseList("obra/superpowers@v6.3.0").entries[0]!)).toBe("obra/superpowers#v6.3.0");
  expect(toSkillsSource(parseList("obra/superpowers").entries[0]!)).toBe("obra/superpowers");
  expect(toSkillsSource(parseList("https://git.x/a/b.git v1").entries[0]!)).toBe("https://git.x/a/b.git#v1");
});

test("node version floor", () => {
  expect(nodeSatisfies("v22.20.0", "22.20.0")).toBe(true);
  expect(nodeSatisfies("v24.1.0", "22.20.0")).toBe(true);
  expect(nodeSatisfies("v22.15.0", "22.20.0")).toBe(false);
  expect(nodeSatisfies("v20.12.2", "22.20.0")).toBe(false);
});

test("installs into every selected agent, records state, and is ok on the second run", async () => {
  const calls: string[][] = [];
  const file = managed();
  const deps = {
    lists: [{ path: "company/skills.list", text: "obra/superpowers@v6.3.0\n" }],
    exec: fakeExec(calls),
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code", "codex"],
    managedFile: file,
    nodeVersion: NODE,
  };
  const r1 = createReporter(() => {}, false);
  expect(await runInstallSkills({ ...deps, reporter: r1 })).toBe(0);
  expect(calls[0]).toEqual(["/bin/skills", "add", "obra/superpowers#v6.3.0", "-g", "-y", "-a", "claude-code", "-a", "codex"]);
  expect(r1.counts().installed).toBe(1);
  expect(loadState(file).skills).toEqual({ "obra/superpowers@v6.3.0": ["claude-code", "codex"] });

  const r2 = createReporter(() => {}, false);
  expect(await runInstallSkills({ ...deps, reporter: r2 })).toBe(0);
  expect(calls).toHaveLength(1);
  expect(r2.counts()).toMatchObject({ ok: 1, installed: 0 });
});

test("a changed agent set or a changed pin re-runs the install", async () => {
  const calls: string[][] = [];
  const file = managed();
  const base = { exec: fakeExec(calls), skillsBin: "/bin/skills", managedFile: file, nodeVersion: NODE };
  await runInstallSkills({ ...base, lists: [{ path: "l", text: "a/b@v1\n" }], skillsAgents: ["claude-code"], reporter: quiet() });
  const r = createReporter(() => {}, false);
  await runInstallSkills({ ...base, lists: [{ path: "l", text: "a/b@v2\n" }], skillsAgents: ["claude-code"], reporter: r });
  expect(calls).toHaveLength(2);
  expect(r.counts().updated).toBe(1);
  expect(Object.keys(loadState(file).skills)).toEqual(["a/b@v2"]);
});

test("a failure counts, exits non-zero, and is not recorded", async () => {
  const file = managed();
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "l", text: "fail/fail@v1\nok/ok@v1\n" }],
    exec: fakeExec([]),
    reporter: r,
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: file,
    nodeVersion: NODE,
  });
  expect(code).toBe(1);
  expect(r.counts()).toMatchObject({ installed: 1, failed: 1 });
  expect(Object.keys(loadState(file).skills)).toEqual(["ok/ok@v1"]);
});

test("a commit hash pin is rejected with the tag advice", async () => {
  const r = createReporter(() => {}, false);
  await runInstallSkills({
    lists: [{ path: "l", text: `a/b@${"f".repeat(40)}\n` }],
    exec: fakeExec([]),
    reporter: r,
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    nodeVersion: NODE,
  });
  expect(r.counts().failed).toBe(1);
});

test("an old node fails before any install; no agents skips", async () => {
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "l", text: "a/b@v1\n" }],
    exec: fakeExec(calls),
    reporter: r,
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    nodeVersion: "v20.12.2",
  });
  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
  const r2 = createReporter(() => {}, false);
  await runInstallSkills({ lists: [{ path: "l", text: "a/b@v1\n" }], exec: fakeExec(calls), reporter: r2, skillsBin: "/bin/skills", skillsAgents: [], managedFile: managed(), nodeVersion: NODE });
  expect(r2.counts().skipped).toBe(1);
});

test("--update bumps each GitHub entry to its highest tag and leaves untagged repos alone", async () => {
  const written: Record<string, string> = {};
  const exec: Exec = async (_cmd, args) => {
    if (args.includes("https://github.com/a/b.git"))
      return { code: 0, stdout: "aaa\trefs/tags/v1.2.0\nbbb\trefs/tags/v1.10.0\nccc\trefs/tags/v0.9.0\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = createReporter(() => {}, false);
  await runInstallSkills({
    lists: [{ path: "company/skills.list", text: "a/b@v1.2.0\nc/d@main\n" }],
    exec,
    reporter: r,
    skillsBin: "/bin/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    nodeVersion: NODE,
    update: true,
    writeList: (path, text) => {
      written[path] = text;
    },
  });
  expect(written["company/skills.list"]).toBe("a/b@v1.10.0\nc/d@main\n");
  expect(r.counts()).toMatchObject({ updated: 1, skipped: 1 });
});
```

Run: `bun test src/commands/install-skills.test.ts` — expected: FAIL.

- [ ] **Step 3: Rewrite the installer**

Replace `packages/cli/src/commands/install-skills.ts`:

```ts
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Exec } from "../exec";
import { type ListEntry, parseList } from "../lists";
import type { Reporter } from "../report";
import { loadState, saveState } from "../state";

export const SKILLS_NODE_FLOOR = "22.20.0";

export function resolveSkillsBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("skills/package.json");
  const pkg: { bin: string | Record<string, string> } = require("skills/package.json");
  const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.skills ?? Object.values(pkg.bin)[0] ?? "");
  return join(dirname(pkgPath), rel);
}

// Our lists write a pin as "@<ref>". The skills CLI reads "@" as a skill-name filter and
// takes the ref after "#" instead. Translate at the boundary so both lists share one format.
export const toSkillsSource = (entry: ListEntry): string =>
  entry.ref === undefined ? entry.repo : `${entry.repo}#${entry.ref}`;

const parts = (v: string): number[] => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
export function nodeSatisfies(version: string, floor: string): boolean {
  const a = parts(version);
  const b = parts(floor);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const isSha = (ref: string | undefined): boolean => ref !== undefined && /^[0-9a-f]{40}$/i.test(ref);
const sameAgents = (a: string[] | undefined, b: string[]): boolean => JSON.stringify(a ?? null) === JSON.stringify(b);

// Highest tag by numeric comparison of "v1.2.3"-like names. Non-numeric tags sort last.
const highestTag = (lsRemote: string): string | undefined =>
  lsRemote
    .split("\n")
    .map((line) => line.split("refs/tags/")[1])
    .filter((t): t is string => t !== undefined && t !== "" && /^v?\d+(\.\d+)*$/.test(t))
    .sort((x, y) => {
      const a = parts(x);
      const b = parts(y);
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
      }
      return 0;
    })[0];

export async function runInstallSkills(deps: {
  lists: { path: string; text: string }[];
  exec: Exec;
  reporter: Reporter;
  skillsBin: string;
  skillsAgents: string[];
  managedFile: string;
  nodeVersion?: string;
  update?: boolean;
  writeList?: (path: string, text: string) => void;
}): Promise<number> {
  const { reporter, exec } = deps;
  reporter.section("Skills");
  const agents = [...deps.skillsAgents].sort();
  const parsed = deps.lists.map((l) => ({ ...l, ...parseList(l.text) }));
  for (const l of parsed) for (const w of l.warnings) reporter.item(`${l.path}: ${w}`, "skipped", "warning only");

  if (deps.update === true) {
    for (const l of parsed) {
      let text = l.text;
      for (const entry of l.entries.filter((e) => e.ref !== undefined)) {
        const url = entry.isUrl === true ? entry.repo : `https://github.com/${entry.repo}.git`;
        const remote = await exec("git", ["ls-remote", "--tags", "--refs", url]);
        const tag = remote.code === 0 ? highestTag(remote.stdout) : undefined;
        if (tag === undefined) {
          reporter.item(entry.repo, "skipped", "no version tag on the remote — pin kept");
          continue;
        }
        if (tag === entry.ref) {
          reporter.item(entry.repo, "ok", `already at ${tag}`);
          continue;
        }
        const next = entry.isUrl === true ? `${entry.repo} ${tag}` : `${entry.repo}@${tag}`;
        text = text.replace(entry.raw, next);
        reporter.item(entry.repo, "updated", `pin ${entry.ref} -> ${tag}`);
      }
      if (text !== l.text) deps.writeList?.(l.path, text);
    }
    return reporter.failed() ? 1 : 0;
  }

  const entries = parsed.flatMap((l) => l.entries);
  if (entries.length === 0) {
    reporter.item("skills", "skipped", "no entries in any skills.list");
    return 0;
  }
  if (agents.length === 0) {
    reporter.item("skills", "skipped", "no selected harness has a skills CLI adapter");
    return 0;
  }
  const nodeVersion = deps.nodeVersion ?? process.version;
  if (!nodeSatisfies(nodeVersion, SKILLS_NODE_FLOOR)) {
    reporter.item(
      "skills",
      "failed",
      `the skills CLI needs Node ${SKILLS_NODE_FLOOR} or newer, this shell runs ${nodeVersion} — run "nvm use" in the company repository`,
    );
    return 1;
  }

  const state = loadState(deps.managedFile);
  const next: Record<string, string[]> = {};
  for (const entry of entries) {
    if (isSha(entry.ref)) {
      reporter.item(entry.raw, "failed", "the skills CLI checks out a tag or a branch, not a commit hash — pin a tag");
      continue;
    }
    const before = state.skills[entry.raw];
    if (sameAgents(before, agents)) {
      next[entry.raw] = agents;
      reporter.item(entry.raw, "ok", "already installed");
      continue;
    }
    const args = ["add", toSkillsSource(entry), "-g", "-y", ...agents.flatMap((a) => ["-a", a])];
    const result = await exec(deps.skillsBin, args);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0 || output.includes("Installation failed")) {
      const reason = output
        .split("\n")
        .map((line) => line.replace(/\[[0-9;?]*[A-Za-z]/g, "").trim())
        .find((line) => /failed|error/i.test(line));
      reporter.item(entry.raw, "failed", reason ?? "skills add failed");
      continue;
    }
    next[entry.raw] = agents;
    const wasKnown = Object.keys(state.skills).some((raw) => raw.split("@")[0] === entry.repo);
    reporter.item(entry.raw, wasKnown ? "updated" : "installed", `agents: ${agents.join(", ")}`);
  }
  // A state entry that no list names any more. A pin bump (same repo, new ref) and a failed
  // entry are not stale: the first is reported as updated, the second as failed.
  const repoOf = (raw: string): string => parseList(raw).entries[0]?.repo ?? raw;
  for (const raw of Object.keys(state.skills).filter((r) => !(r in next))) {
    if (entries.some((e) => e.raw === raw || e.repo === repoOf(raw))) continue;
    reporter.item(raw, "skipped", "no longer listed — remove by hand with: skills remove -g <skill-name>");
  }
  state.skills = next;
  saveState(deps.managedFile, state);
  return reporter.failed() ? 1 : 0;
}
```

Run: `bun test src/commands/install-skills.test.ts src/state.test.ts` — expected: PASS.

- [ ] **Step 4: Commit**

`bun run typecheck` is red in `index.ts` and `update.ts` (old call shape). That is expected until Task 8.

```bash
bun run check
git add packages/cli/src/state.ts packages/cli/src/state.test.ts packages/cli/src/commands/install-skills.ts packages/cli/src/commands/install-skills.test.ts
git commit -m "feat(cli): skills installer — #ref translation, per-harness agents, state-based idempotency, node floor"
```

---

### Task 5: Harness-aware sync, subagents, and MCP writer

**Files:**
- Modify: `packages/cli/src/commands/sync-agents.ts`, `sync-agents.test.ts`
- Modify: `packages/cli/src/commands/install-agents.ts`, `install-agents.test.ts`
- Modify: `packages/cli/src/commands/write-mcp.ts`, `write-mcp.test.ts`

**Interfaces:**
- Consumes: `Harness` from `../harness`.
- Produces:

```ts
runSyncAgents(deps: { home; harnesses: Harness[]; instructionDirs: string[]; reporter; options?; backups? }): number
runInstallAgents(deps: { home; harnesses: Harness[]; listTexts: { path; text }[]; agentDirs: { prefix: string; dir: string }[]; exec; reporter; backups? }): Promise<number>
runWriteMcp(deps: { home; harnesses: Harness[]; proxies: ProxyConfig[]; env: NodeJS.ProcessEnv; reporter; dryRun?; backups? }): number
export function missingEnvVars(proxies: ProxyConfig[], env: NodeJS.ProcessEnv): string[]  // in write-mcp.ts
```

- [ ] **Step 1: sync-agents — selected harnesses and many instruction directories**

Change the signature: `harnesses: Harness[]` replaces the `HARNESSES` import, and `instructionDirs: string[]` replaces `instructionsDir?`. Concatenate the `.md` files of each directory in order (each directory sorted by filename, directories in the given order, missing directories skipped):

```ts
const instructions = deps.instructionDirs
  .filter((dir) => existsSync(dir))
  .flatMap((dir) =>
    [...readdirSync(dir)]
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => readFileSync(join(dir, f), "utf8")),
  );
```

Loop `for (const harness of deps.harnesses)`. Update every test in `sync-agents.test.ts`: pass `harnesses: HARNESSES` where the old behavior is wanted, replace `.gemini/config/rules/global.md` with `.gemini/GEMINI.md`, and add:

```ts
test("writes only the selected harnesses and appends team instructions after company ones", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-home-"));
  const company = join(home, "co");
  const team = join(home, "team");
  mkdirSync(company);
  mkdirSync(team);
  writeFileSync(join(company, "00.md"), "## Company\n");
  writeFileSync(join(team, "00.md"), "## Team\n");
  const codex = HARNESSES.find((h) => h.name === "codex");
  if (codex === undefined) throw new Error("codex missing");
  runSyncAgents({ home, harnesses: [codex], instructionDirs: [company, team], reporter: quiet() });
  expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(false);
  const text = readFileSync(join(home, ".codex/AGENTS.md"), "utf8");
  expect(text.indexOf("## Company")).toBeLessThan(text.indexOf("## Team"));
});
```

Run: `bun test src/commands/sync-agents.test.ts` — expected: PASS.

- [ ] **Step 2: install-agents — selected harnesses, layered agent directories, one skip line**

Change the signature: `harnesses: Harness[]`, and `agentDirs: { prefix: string; dir: string }[]` replaces `companyAgentsDir?`. Targets are `deps.harnesses.filter((h) => h.subagentDir !== undefined)`. Replace the per-harness "skipped" loop with one line, only when at least one selected harness lacks a directory:

```ts
const without = deps.harnesses.filter((h) => h.subagentDir === undefined).map((h) => h.name);
if (without.length > 0) reporter.item("subagents", "skipped", `no Markdown subagent directory: ${without.join(", ")}`);
```

Replace the company block with a loop over `agentDirs`: for each `{ prefix, dir }` that exists, install every `.md` except `readme.md` (case-insensitive) as `${prefix}${file}` into every target. The callers (Task 8) pass `{ prefix: "company__", dir: company.company.agentsDir }` first, then `{ prefix: \`${team.name}__\`, dir: team.agentsDir }` per team layer.

Update `install-agents.test.ts`: pass `harnesses: HARNESSES` and `agentDirs` in place of the old fields; add one test that a team directory installs with its prefix and that a run with `harnesses: [codex]` produces zero files plus one skipped line.

Run: `bun test src/commands/install-agents.test.ts` — expected: PASS.

- [ ] **Step 3: write-mcp — selected harnesses, skip blank, unset variable warnings**

Add to `write-mcp.ts`:

```ts
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
```

In `runWriteMcp`: take `harnesses: Harness[]` and `env: NodeJS.ProcessEnv`. Before the harness loop, report each missing variable once:

```ts
for (const name of missingEnvVars(proxies, deps.env)) {
  reporter.item(name, "skipped", "not set in this shell — add it to .env.credentials, then open a new terminal");
}
```

Collapse the "no MCP config adapter" lines into one, like Task 5 Step 2. Inside the loop, after computing `entries` and `previouslyOwned`:

```ts
if (Object.keys(entries).length === 0 && previouslyOwned.length === 0) {
  reporter.item(mcpTarget.path, "skipped", "no MCP servers in the registry — file not created");
  continue;
}
```

Update `write-mcp.test.ts`: pass `harnesses: HARNESSES` and `env: {}` in existing tests; add:

```ts
test("an empty registry creates no file", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-mcp-"));
  const r = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [], env: {}, reporter: r });
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
  expect(r.counts().skipped).toBeGreaterThan(0);
});

test("reports every ${VAR} that is not set in the shell", () => {
  const proxies = loadRegistry(
    "proxies:\n  - namespace: a\n    mode: remote_http\n    endpoint: https://x/mcp\n    auth: { scheme: { kind: bearer }, source: { from: env, var: A_TOKEN } }\n  - namespace: b\n    mode: stdio_cmd\n    command: run\n    env: { B_KEY: \"${B_KEY}\" }\n",
    "r.yaml",
  );
  expect(missingEnvVars(proxies, { A_TOKEN: "x" })).toEqual(["B_KEY"]);
});
```

Run: `bun test src/commands/write-mcp.test.ts` — expected: PASS.

- [ ] **Step 4: Commit**

```bash
bun run check
git add packages/cli/src/commands/sync-agents.ts packages/cli/src/commands/sync-agents.test.ts packages/cli/src/commands/install-agents.ts packages/cli/src/commands/install-agents.test.ts packages/cli/src/commands/write-mcp.ts packages/cli/src/commands/write-mcp.test.ts
git commit -m "feat(cli): provision only the selected harnesses, team layers, no blank MCP file, unset-variable warnings"
```

---

### Task 6: Onboarding guidance when the username is unknown

**Files:**
- Modify: `packages/cli/src/identity.ts`
- Modify: `packages/cli/src/identity.test.ts`

**Interfaces:**
- Produces: `getUsername(exec, ask, catalog, hint?: { companyRoot: string })`. The fourth argument is optional, so existing callers compile. Task 8 passes it.

- [ ] **Step 1: Write the failing tests**

Add to `identity.test.ts` (reuse the existing fakes in that file):

```ts
test("a rejected answer explains how to add the User entity", async () => {
  const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "" });
  await expect(getUsername(exec, async () => "carol", catalog, { companyRoot: "/srv/co" })).rejects.toThrow(
    /teams\/<your-team>\/catalog\.yaml.*\/srv\/co/s,
  );
});

test("a rejected stored name explains how to change it", async () => {
  const exec: Exec = async () => ({ code: 0, stdout: "ghost\n", stderr: "" });
  await expect(getUsername(exec, async () => "", catalog)).rejects.toThrow(/git config --global --unset wagglebot\.username/);
});
```

Run: `bun test src/identity.test.ts` — expected: FAIL.

- [ ] **Step 2: Implement**

```ts
const reject = (catalog: Catalog, value: string, stored: boolean, hint?: { companyRoot: string }): never => {
  const near = nearMatches(catalog, value);
  const lines = [`username "${value}" matches no User entity in the catalog.`];
  if (near.length > 0) lines.push(`Near matches: ${near.join(", ")}.`);
  const where = hint === undefined ? "the company repository" : hint.companyRoot;
  lines.push(
    `To add yourself: in ${where}, add a User entity named "${value}" to teams/<your-team>/catalog.yaml and add "${value}" to the members of that Group. Merge the pull request, then run this command again.`,
  );
  if (stored) lines.push("To change the stored name: git config --global --unset wagglebot.username");
  throw new Error(lines.join("\n"));
};

export async function getUsername(exec: Exec, ask: Ask, catalog: Catalog, hint?: { companyRoot: string }): Promise<string> {
  const stored = await exec("git", ["config", "--global", "wagglebot.username"]);
  const current = stored.stdout.trim();
  if (current !== "") {
    if (findUser(catalog, current) === undefined) reject(catalog, current, true, hint);
    return current;
  }
  const answer = (await ask("Company Git username (as listed in the catalog): ")).trim();
  if (findUser(catalog, answer) === undefined) reject(catalog, answer, false, hint);
  await exec("git", ["config", "--global", "wagglebot.username", answer]);
  return answer;
}
```

Run: `bun test src/identity.test.ts` — expected: PASS.

- [ ] **Step 3: Commit**

```bash
bun run check
git add packages/cli/src/identity.ts packages/cli/src/identity.test.ts
git commit -m "fix(cli): tell an unknown user how to join the catalog"
```

---

### Task 7: A Memory section that is true in Phase 1

**Files:**
- Modify: `packages/cli/templates/AGENTS.base.md` (the `## Memory` section only)
- Modify: `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md` (the fenced `## Memory` block under "Seed content", same text)

Phase 1 has no memory server, no `remember` tool, and no `forget` tool. Nothing loads `.agents/memory.md` into a session, so the agent must be told to read it.

- [ ] **Step 1: Replace the section in both files**

Replace everything from `## Memory` to the end of the template (and the same fenced block in the spec) with:

```markdown
## Memory

You decide what to remember. No model repeats this work, so a fact you
skip is lost, and a fact you invent is believed.

WHAT TO REMEMBER

Remember only durable facts:

* A decision, and the reason for it.
* A convention that the code does not state.
* A trap that cost you time.
* Who owns what.

Do not remember:

* A transcript, or a summary of one session.
* A fact the code already states. Read the code instead.
* A guess, an attempt, or a dead end.
* Anything about a person, beyond their role and their ownership.
* A secret. Never write one.

Write few facts. A large memory is a haystack.

WHERE MEMORY LIVES

Component memory is one file in the repository you work in:

    .agents/memory.md

Read it at the start of a session, before you plan. Edit it when you
learn a durable fact about this repository. The file is committed, so a
pull request reviews every change, and git keeps the history.

A fact that crosses a repository boundary has no home yet. The shared
memory store arrives with the wagglebot shared layer. Until then, tell
your engineer the fact in the session, and let them place it. Do not
invent a memory tool. Do not write outside `.agents/memory.md`.

BEFORE YOU WRITE

1. Read `.agents/memory.md` first.
2. If the fact exists, update it. Do not add a duplicate.
3. If the fact contradicts an existing one, say so to your engineer.

WHEN TO WRITE

Write at the end of a session, and after you learn something that cost
you time. Do not write during exploration.

WHEN YOUR ENGINEER TELLS YOU TO REMEMBER SOMETHING

Write it to `.agents/memory.md`.

* Do not judge the importance. They asked, so write it.
* When they tell you a fact is wrong, remove it.
```

- [ ] **Step 2: Verify and commit**

Run: `grep -n "remember\` tool\|forget\|server rejects" packages/cli/templates/AGENTS.base.md` — expected: no output. Run `bun test src/commands/sync-agents.test.ts e2e/provisioning.test.ts` — expected: PASS (the tests only assert `## Memory`).

```bash
git add packages/cli/templates/AGENTS.base.md docs/superpowers/specs/2026-08-28-phase-1-provisioning.md
git commit -m "docs(template): memory section describes Phase 1 — one local file, no tools yet"
```

---

### Task 8: Wire selection, layers, shell sync, and per-command help

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `packages/cli/src/commands/update.ts`
- Modify: `packages/cli/src/commands/update.test.ts`
- Create: `packages/cli/src/help.ts`, `packages/cli/src/help.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–6.
- Produces: `helpText(command?: string): string` in `help.ts`. `wagglebot sync-shell` command. `runUpdate` calls, in order: `install-skills`, `install-agents`, `sync-agents`, `sync-shell`, `write-mcp`.

- [ ] **Step 1: Write the failing help tests**

Create `packages/cli/src/help.test.ts`:

```ts
import { expect, test } from "bun:test";
import { helpText } from "./help";

test("general help lists every command and the two git config keys", () => {
  const text = helpText();
  for (const c of ["update", "init", "install-skills", "install-agents", "sync-agents", "sync-shell", "write-mcp"])
    expect(text).toContain(`  ${c}`);
  expect(text).toContain("wagglebot.username");
  expect(text).toContain("wagglebot.harnesses");
});

test("command help names what the command reads and writes", () => {
  const sync = helpText("sync-agents");
  expect(sync).toContain("company/instructions/");
  expect(sync).toContain("~/.claude/CLAUDE.md");
  expect(sync).not.toContain("~/.claude.json");
  const mcp = helpText("write-mcp");
  expect(mcp).toContain("registry.yaml");
  expect(mcp).toContain("~/.claude.json");
  const shell = helpText("sync-shell");
  expect(shell).toContain("~/.zshenv");
  expect(shell).toContain(".env.credentials");
  const update = helpText("update");
  expect(update).toContain("~/.zshenv");
  expect(update).toContain("~/.claude/agents/");
});

test("unknown command help falls back to the general text", () => {
  expect(helpText("nope")).toBe(helpText());
});
```

- [ ] **Step 2: Implement help.ts**

```ts
import { HARNESSES } from "./harness";
import { HARNESS_CONFIG_KEY } from "./harness-select";
import { SHELL_RC_FILES } from "./commands/sync-shell";

type Section = { title: string; purpose: string; reads: string[]; writes: string[]; flags?: string[] };

const templateFiles = () => HARNESSES.flatMap((h) => h.templateTargets.map((t) => `~/${t}  (${h.name}, managed block)`));
const hookFiles = () => HARNESSES.flatMap((h) => (h.hooksTarget ? [`~/${h.hooksTarget.path}  (${h.name}, managed hook entries)`] : []));
const mcpFiles = () => HARNESSES.flatMap((h) => (h.mcpTarget ? [`~/${h.mcpTarget.path}  (${h.name}, managed keys under ${h.mcpTarget.parentKey})`] : []));
const subagentDirs = () => HARNESSES.flatMap((h) => (h.subagentDir ? [`~/${h.subagentDir}/  (${h.name}, files prefixed company__ or <team>__)`] : []));
const shellFiles = () => SHELL_RC_FILES.map((f) => `~/${f.file}  (managed block${f.createIfMissing ? "" : ", only when the file exists"})`);
const skillDirs = () => HARNESSES.flatMap((h) => (h.skillsAgent ? [`the global skills directory of ${h.name}  (written by the skills CLI, --agent ${h.skillsAgent})`] : []));

const LAYERS = "company/ and teams/<team>/ for each team of the engineer";

const SECTIONS: Record<string, Section> = {
  "install-skills": {
    title: "install-skills",
    purpose: "Installs every entry of the curated skills lists with the skills CLI, into the selected harnesses.",
    reads: [`skills.list in ${LAYERS}`],
    writes: [...skillDirs(), "~/.wagglebot/managed.json  (which entry was installed for which harness)"],
    flags: ["--update    Bump each pinned entry to the highest version tag on its remote and rewrite the list."],
  },
  "install-agents": {
    title: "install-agents",
    purpose: "Installs the shared Markdown subagents: company/agents/, teams/<team>/agents/, and every repository in the agents lists.",
    reads: [`agents/*.md and agents.list in ${LAYERS}`, "~/.wagglebot/agents-cache/  (clones of listed repositories)"],
    writes: [...subagentDirs(), "~/.wagglebot/managed.json  (every subagent file it wrote)"],
  },
  "sync-agents": {
    title: "sync-agents",
    purpose: "Writes the base prompt plus the company and team instructions into the global instruction file of each selected harness, and merges the hook fragments.",
    reads: ["the base prompt shipped in the wagglebot package", `company/instructions/*.md, then teams/<team>/instructions/*.md`],
    writes: [...templateFiles(), ...hookFiles()],
    flags: ["--restore [~/path]   Write the newest backup set back (every file, or one file)."],
  },
  "sync-shell": {
    title: "sync-shell",
    purpose: "Adds a managed block to the shell startup files that loads .env.credentials from the company repository into every new shell.",
    reads: [".env.credentials  (at shell start, never by wagglebot itself)"],
    writes: shellFiles(),
  },
  "write-mcp": {
    title: "write-mcp",
    purpose: "Writes the merged MCP registry into the MCP config of each selected harness. Credentials appear as ${VAR} only.",
    reads: [`registry.yaml in ${LAYERS}  (a team entry with the same namespace wins)`],
    writes: [...mcpFiles(), "~/.wagglebot/managed.json  (every key it wrote)"],
  },
  init: {
    title: "init [dir]",
    purpose: "Scaffolds a new company repository. Refuses a directory that is not empty.",
    reads: [],
    writes: ["package.json, README.md, company/, teams/team-payments/, and the example files"],
  },
};

const render = (s: Section): string[] => [
  `wagglebot ${s.title}`,
  "",
  s.purpose,
  "",
  ...(s.reads.length > 0 ? ["Reads:", ...s.reads.map((r) => `  ${r}`), ""] : []),
  "Writes:",
  ...s.writes.map((w) => `  ${w}`),
  ...(s.flags ? ["", "Flags:", ...s.flags.map((f) => `  ${f}`)] : []),
];

const GENERAL = (): string[] => [
  "wagglebot — one AI agent setup for a whole engineering team.",
  "",
  "Usage: wagglebot <command> [options]",
  "",
  "Commands:",
  "  update             Pull the company repository, then run every installer below.",
  "  init [dir]         Scaffold a new company repository.",
  "  install-skills     Install the curated skills lists.",
  "  install-agents     Install the shared subagents.",
  "  sync-agents        Write the base prompt and instructions into every selected harness.",
  "  sync-shell         Load .env.credentials into new shells.",
  "  write-mcp          Write MCP server configs from the registry.",
  "",
  "Options:",
  "  --version          Print the wagglebot version.",
  "  --help             Print this help. `wagglebot <command> --help` describes one command.",
  "",
  "Workstation settings (global git config):",
  "  wagglebot.username    The company Git username. Asked once, then stored. Must be a User in the catalog.",
  `  ${HARNESS_CONFIG_KEY}   Comma-separated harness names to provision. Default: every harness whose`,
  `                        directory exists under ~. Valid: ${HARNESSES.map((h) => h.name).join(", ")}.`,
  "",
  "Every mutation lands inside a managed block (<!-- wagglebot:begin --> in Markdown, # wagglebot:begin",
  "in shell files, recorded keys in JSON). Content outside stays untouched. Changed files are backed up",
  "to ~/.wagglebot/backups/<timestamp>/ first. Restore with `wagglebot sync-agents --restore`.",
];

export function helpText(command?: string): string {
  if (command === "update") {
    const all = ["install-skills", "install-agents", "sync-agents", "sync-shell", "write-mcp"].map((c) => SECTIONS[c]);
    return [
      "wagglebot update",
      "",
      "1. git pull --ff-only in the company repository.",
      "2. yarn install, when the wagglebot pin in package.json moved, then re-run itself.",
      "3. Run every installer, in this order:",
      "",
      ...all.flatMap((s) => (s ? [...render(s), ""] : [])),
      "Flags:",
      "  --skip-self-update   Internal. Set by the re-run after a pin move.",
    ].join("\n");
  }
  const section = command === undefined ? undefined : SECTIONS[command];
  if (section !== undefined) return render(section).join("\n");
  return GENERAL().join("\n");
}
```

Run: `bun test src/help.test.ts` — expected: PASS.

- [ ] **Step 3: Rewire index.ts**

Remove the local `helpText` from `index.ts` and import it from `./help`. Change the `--help` branch: `if (rest.includes("--help") || rest.includes("-h")) { deps.write(helpText(command)); return 0; }`.

Add a helper in `index.ts`:

```ts
async function selected(home: string, exec: Exec, write: (line: string) => void) {
  const { harnesses, source } = await selectHarnesses(home, exec);
  const hint = source === "detected" ? `detected — override with: git config --global ${HARNESS_CONFIG_KEY} <names>` : "from git config";
  write(`harnesses: ${harnesses.map((h) => h.name).join(", ")} (${hint})`);
  return harnesses;
}
```

Extend `companyContext` to also call `assertTeamDirsKnown(company, catalog.groups.map((g) => g.name))` and pass `{ companyRoot: root }` to `getUsername`. Then per command:

- `install-skills`: `companyContext` for teams; `lists = company.layersFor(teams).flatMap((l) => l.skillsListText === undefined ? [] : [{ path: join(l.dir, "skills.list"), text: l.skillsListText }])`; `skillsAgents = harnesses.flatMap((h) => h.skillsAgent ? [h.skillsAgent] : [])`; `managedFile: resolvePaths(home).managedFile`; `writeList: (path, text) => writeFileSync(path, text)` when `--update`.
- `install-agents`: `agentDirs = company.layersFor(teams).map((l) => ({ prefix: \`${l.name}__\`, dir: l.agentsDir }))`; `listTexts` as in Task 3 Step 3.
- `sync-agents`: `instructionDirs = company.layersFor(teams).map((l) => l.instructionsDir)` — this now needs the company context (username), so drop the try/catch fallback; `--restore` still works without harness selection: check `values.restore` before selecting.
- `sync-shell` (new): `runSyncShell({ home, companyRoot: root, reporter })`.
- `write-mcp`: pass `harnesses` and `env: process.env`.

- [ ] **Step 4: Rewire update.ts**

After the pin check and identity, add `const harnesses = await selectHarnesses(...)` (write the same one-line summary), `assertTeamDirsKnown`, and the same argument construction as Step 3. Call order: `runInstallSkills`, `runInstallAgents`, `runSyncAgents`, `runSyncShell`, `runWriteMcp`. Pass `{ companyRoot: root }` to `getUsername`. Update `update.test.ts`: its fake exec must answer `git config --global wagglebot.harnesses` with `{ code: 1, stdout: "" }` and the scratch home must contain a `.claude` directory (`mkdirSync(join(home, ".claude"))`), or the fake returns `"claude-code"` for that key. Assert that `.zshenv` exists in the scratch home after a successful update, and that the installers ran in the new order if the test tracks calls.

- [ ] **Step 5: Update index.test.ts**

Adjust the help assertions to the new text (`helpText()` content: `sync-shell`, `wagglebot.harnesses`) and add `expect(await main(["write-mcp", "--help"], { write }))` returns 0 with output containing `~/.claude.json`.

- [ ] **Step 6: Full gate, manual run, commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run check && bun run typecheck && bun test && bun run build
```

Manual smoke against a scratch home and the scaffold (use Node 22 so the skills CLI runs):

```bash
S=$(mktemp -d); mkdir -p "$S/home/.claude"; cd "$S"
node /Users/lr/Sites/swiknaba/wagglebot/packages/cli/bin/wagglebot.js init app
cd app && sed -i '' 's#"wagglebot": ".*"#"wagglebot": "file:/Users/lr/Sites/swiknaba/wagglebot/packages/cli"#' package.json
git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init
git init -q --bare ../remote.git && git remote add origin ../remote.git && git push -q -u origin HEAD
echo alice | HOME="$S/home" GIT_CONFIG_GLOBAL="$S/home/.gitconfig" ~/.nvm/versions/node/v22.15.0/bin/node /Users/lr/Sites/swiknaba/wagglebot/packages/cli/bin/wagglebot.js update
HOME="$S/home" GIT_CONFIG_GLOBAL="$S/home/.gitconfig" ~/.nvm/versions/node/v22.15.0/bin/node /Users/lr/Sites/swiknaba/wagglebot/packages/cli/bin/wagglebot.js update
find "$S/home" -type f | grep -v "/\.git/" | sort
```

Expected: the first run prints `harnesses: claude-code (detected ...)`, installs two skills entries into `~/.claude/skills/`, writes `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.zshenv`, and no `~/.junie`, `~/.codex`, `~/.gemini`, or `~/.claude.json`. The second run reports every item `ok` or `skipped`, none `updated`. Note: `skills add` reaches github.com — if the network is unavailable, the two skills lines fail and everything else must still pass.

```bash
git add packages/cli/src
git commit -m "feat(cli): harness selection, team layers, sync-shell in update, per-command help"
```

---

### Task 9: Docs, spec, CI, e2e, reference app

**Files:**
- Modify: `packages/cli/package.json` (`engines.node` → `">=22.20.0"`)
- Modify: `.github/workflows/ci.yml`
- Modify: `packages/cli/e2e/provisioning.test.ts`
- Modify: `packages/cli/templates/init/README.md`
- Modify: `packages/cli/README.md`, `README.md`
- Modify: `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md`
- Regenerate: `test-app/`

- [ ] **Step 1: Engines and CI**

Set `"engines": { "node": ">=22.20.0" }` in `packages/cli/package.json`. In `ci.yml`, change the smoke step to a matrix of Node `22` and `24` for `node packages/cli/bin/wagglebot.js --version` (two `setup-node` steps are fine, keep it simple: one job step per version).

- [ ] **Step 2: e2e provisioning test**

The sandbox home must contain `.claude` so detection finds one harness, and git config must not touch the real machine: add `GIT_CONFIG_GLOBAL: join(scratchHome, ".gitconfig")` to `env` and `mkdirSync(join(scratchHome, ".claude"))` in `beforeAll`. Because `sync-agents` now needs the username, set it first in the scratch config: `execFileSync("git", ["config", "--global", "wagglebot.username", "alice"], { env })`. Replace the `.gemini/config/rules/global.md` assertion with `expect(existsSync(join(scratchHome, ".gemini"))).toBe(false)` (not detected, not created). Add a `sync-shell` run and assert `~/.zshenv` contains `# wagglebot:begin`. Add a `--help` run: `runCli(["write-mcp", "--help"])` status 0, stdout contains `~/.claude.json`.

Run: `bun test e2e/` — expected: PASS.

- [ ] **Step 3: Scaffold README**

Replace `packages/cli/templates/init/README.md` with:

```markdown
# Company Agent Environment

Provisioned by [wagglebot](https://github.com/swiknaba/wagglebot) {{WAGGLEBOT_VERSION}}.

## Before Your First Run

You need a User entity in the catalog. Ask your team to add you to
`teams/<team>/catalog.yaml`: one `User` entity with your company Git
username, and your name in the `members` of the team Group. Merge that
pull request first.

You need Node 22.20 or newer. Run `nvm use` in this directory.

## Setup

1. Run `git clone <this repo>`.
2. Run `yarn install`.
3. Run `yarn update:wagglebot`.
4. Open a new terminal.

The first run asks for your company Git username once and stores it in
your global git config. It then provisions this workstation: skills,
subagents, base prompts, MCP configs, and a shell block that loads your
credentials. Run it again after each merge to this repository.

## Which Harnesses

Wagglebot provisions every agent harness whose directory exists under
your home directory, for example `~/.claude` or `~/.codex`. To choose
explicitly, run:

    git config --global wagglebot.harnesses claude-code,codex

Run `yarn wagglebot --help` for the valid names.

## Credentials

Copy `.env.credentials.example` to `.env.credentials` and fill the
values. The file is gitignored. No credential ever enters this
repository. `wagglebot update` adds a block to `~/.zshenv` (and to
`~/.bashrc` when it exists) that exports the file into every new shell.
Start an agent harness from a new terminal so it sees the variables.

## Layout

| Path | Applies to | Content |
|---|---|---|
| `company/` | Everyone | `registry.yaml`, `skills.list`, `agents.list`, `agents/`, `instructions/`, optional `catalog.yaml` |
| `teams/<team>/` | Members of Group `<team>` | The same files. `catalog.yaml` is required. |

The directory name under `teams/` must equal the Group name. Every
`catalog.yaml` merges into one catalog, and an unknown name is a hard
error.

## Upgrade

Bump the `wagglebot` pin in `package.json` in a pull request. Review
the wagglebot changelog for base-template changes.
```

- [ ] **Step 4: Package and root READMEs**

In `packages/cli/README.md`: add `sync-shell` to the command table, add a "Workstation settings" paragraph naming `wagglebot.username` and `wagglebot.harnesses`, and state the Node floor. In the root `README.md`: in "Phase 1 — local, zero services", add the bullet `* Your credentials load into every new shell from one gitignored file.` and replace the "Test App" section sentence about `sync-agents` with one that names the sandboxed provisioning run and the drift gate.

- [ ] **Step 5: Spec updates**

In `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md`:

- "The Update Command": list five installers (`install-skills`, `install-agents`, `sync-agents`, `sync-shell`, the MCP config writer). Add a paragraph "Harness selection" that states the detection rule and the `wagglebot.harnesses` key. Add a paragraph "Credentials reach the shell" describing the `~/.zshenv` block and the shipped `templates/shell/wagglebot.sh`.
- "Curated Skills List": path `company/skills.list` and `teams/<team>/skills.list`; the rule "The skills CLI checks out a tag or a branch, never a commit hash, so a skills pin is a tag"; the two real seed entries.
- "The lists": `company/agents.list` and `teams/<team>/agents.list`; company agents in `company/agents/`, team agents in `teams/<team>/agents/`.
- "Distribution" table: replace with the six verified rows (Claude Code `~/.claude/CLAUDE.md`; Codex `~/.codex/AGENTS.md`; Junie `~/.junie/AGENTS.md`; Cline `~/.cline/rules/wagglebot.md`; Gemini CLI `~/.gemini/GEMINI.md`; GitHub Copilot CLI `~/.copilot/copilot-instructions.md`). Add "Subagent directories: Claude Code `~/.claude/agents/`, Junie `~/.junie/agents/`."
- Add a "Company repository layout" section with the tree from Task 3.
- Success criterion 1: add "and the shell block". Add criterion 12: "`wagglebot update` on a machine with only Claude Code creates no directory for any other harness."

- [ ] **Step 6: Regenerate the reference app and run the full gate**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run regen:test-app
bun run check && bun run typecheck && bun test && bun run build
```

Expected: PASS. Then:

```bash
git add -A packages/cli/package.json .github/workflows/ci.yml packages/cli/e2e packages/cli/templates/init/README.md packages/cli/README.md README.md docs/superpowers/specs/2026-08-28-phase-1-provisioning.md test-app
git commit -m "docs: onboarding, harness selection, credentials, layout; ci node 22/24; e2e detection"
```

---

## Coverage Notes (review finding → task)

| Finding | Task |
|---|---|
| Credentials never reach the harness | 2 (block + script), 5 (unset warnings), 8 (in `update`), 9 (README) |
| Harness paths wrong or unverified | 1, 9 (spec table) |
| Memory section describes Phase 2 | 7 |
| Fresh scaffold installs zero skills; `@ref` and SHA pins break the skills CLI; Node floor | 3 (seed list), 4 (installer) |
| Unknown user gets no onboarding guidance | 6, 9 (README) |
| Every machine gets all harness directories, ten skipped lines | 1 (selection), 5 (collapsed lines), 8 |
| Empty registry creates `~/.claude.json` | 5 |
| Inconsistent layout, no team instructions | 3, 5, 8 |
| Per-command `--help` is the global text | 8 |
