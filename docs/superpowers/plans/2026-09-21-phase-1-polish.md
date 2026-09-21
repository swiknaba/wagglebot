# Phase 1 Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Phase 1 workflow: one connected company setup, nine local harnesses, simple project commands, committed memory and changelog files, and offline automated verification.

**Architecture:** Keep project publishing independent from company provisioning. Resolve company configuration from a marked working tree or a validated local cache. Use a small bootstrap layer to refresh the cache and run the exact pinned Wagglebot package. Feed one resolved company context into shared provisioning stages. Extend the current harness table so each adapter declares its instruction, skill, agent, hook, and MCP targets.

**Tech Stack:** TypeScript 5.9, Bun test and bundler, Node.js 22.20 or newer, Git, npm, YAML 2.8, and `skills` CLI 1.5.23.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-1-polish-design.md`

## Global Constraints

- Write a failing test before each behavior change.
- Do not invoke a harness or an LLM in tests or commands.
- Use only local Git remotes and local skill or agent fixtures during tests.
- Configure all nine harnesses. Do not inspect installed harness directories.
- Preserve personal content by default. Change only Wagglebot-owned blocks, entries, files, and state.
- Treat `--overwrite-local` as destructive authorization for the five supported categories only.
- In overwrite mode, do not create a backup. Preserve unrelated IDE settings.
- Never write a credential value. Write a documented variable reference, or skip that MCP entry.
- Keep project memory and changelog files in Git. Never add them to `.gitignore`.
- Keep the existing Phase 2 `brain` code independent. Do not add it to Phase 1 project initialization.
- Keep native Windows out of scope. Linux tests cover WSL filesystem behavior.
- Apply ASD-STE100 guidance to new prose, help text, comments, and documentation.
- Run focused tests after each task. Run the complete verification set before completion.
- Use one focused commit per task. Do not include unrelated worktree changes.

---

## Task 1: Detect marked company repositories and allow an optional catalog

**Files:**

- Modify: `packages/company-config/package.json`
- Modify: `packages/company-config/src/company.ts`
- Modify: `packages/company-config/src/index.ts`
- Modify: `packages/cli/src/company.ts`
- Modify: `packages/cli/src/company.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/commands/update.ts`
- Modify: `packages/cli/src/project-root.ts`
- Modify: `packages/cli/src/project-root.test.ts`

**Interfaces:**

```ts
export type CompanyCatalog = { text: string; path: string };

export type CompanyRepo = {
  root: string;
  pin: string;
  organization: string[];
  company: Layer;
  teams: Layer[];
  catalog?: CompanyCatalog;
  layersFor: (teamNames: string[]) => Layer[];
};

export function readCompanyMarker(root: string): { version: 1; kind: "company" } | undefined;
export function isCompanyRoot(root: string): boolean;
export function findGitRoot(cwd: string): string;
```

- [ ] **Step 1: Write failing marker and optional-catalog tests**

Add tests that prove:

- `wagglebot.yaml` with `version: 1` and `kind: company` identifies the Git root.
- A missing marker makes `loadCompanyRepo` fail with the marker path.
- Extra marker fields, another version, or another kind fail validation.
- `package.json.name` does not select company mode.
- A repository with `company/` and no catalog loads successfully with `catalog === undefined`.
- Multiple catalog files join in sorted company/team order when present.

Use this fixture in `company.test.ts`:

```ts
writeFileSync(join(root, "wagglebot.yaml"), "version: 1\nkind: company\n");
writeFileSync(
  join(root, "package.json"),
  JSON.stringify({ dependencies: { wagglebot: "1.2.3" } }),
);
mkdirSync(join(root, "company", "instructions"), { recursive: true });
```

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/cli/src/company.test.ts packages/cli/src/project-root.test.ts`

Expected: FAIL because the loader still infers a company repository from its dependency and requires a catalog.

- [ ] **Step 3: Implement strict marker loading and optional catalog state**

Add `yaml` as a direct dependency of `@wagglebot/company-config`. Parse the marker as YAML, require exactly the two supported values, and reject malformed input. Make `findGitRoot` the neutral Git-root function. Let `loadCompanyRepo` return an optional catalog instead of throwing when none exists.

Do not validate team names in this loader. Catalog validation belongs to the later company-context step.

Re-export the new types and functions through `packages/cli/src/company.ts`. Keep `findCompanyRoot` and `assertTeamDirsKnown` as compatibility exports until Task 10.

Adapt the two current company callers to the optional `company.catalog` shape. Preserve their current catalog-required behavior until Task 10 adds company-only fallback behavior.

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/company.test.ts packages/cli/src/project-root.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/company-config/package.json packages/company-config/src/company.ts packages/company-config/src/index.ts packages/cli/src/company.ts packages/cli/src/company.test.ts packages/cli/src/index.ts packages/cli/src/commands/update.ts packages/cli/src/project-root.ts packages/cli/src/project-root.test.ts bun.lock
git commit -m "Detect marked company repositories"
```

---

## Task 2: Add company URL configuration and `connect`

**Files:**

- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/paths.ts`
- Modify: `packages/cli/src/paths.test.ts`
- Create: `packages/cli/src/company-url.ts`
- Create: `packages/cli/src/company-url.test.ts`
- Create: `packages/cli/src/commands/connect.ts`
- Create: `packages/cli/src/commands/connect.test.ts`

**Interfaces:**

```ts
export type WagglebotConfig = { companyRepository?: string };
export type PackageMetadata = {
  version: string;
  wagglebot?: { companyRepository?: string };
};

export function resolveCompanyRepositoryUrl(input: {
  env: NodeJS.ProcessEnv;
  config: WagglebotConfig;
  packageMetadata: PackageMetadata;
}): string;

export function runConnect(input: {
  url: string;
  configFile: string;
  reporter: Reporter;
}): number;
```

- [ ] **Step 1: Write failing precedence and persistence tests**

Cover these cases:

1. `WAGGLEBOT_COMPANY_REPOSITORY_URL` wins.
2. A saved URL wins over package metadata.
3. Package metadata supplies the fallback.
4. Every `.example` host counts as unset and is never returned.
5. No usable URL produces `Run "wagglebot connect <git-url>" first.`
6. `connect` creates `~/.wagglebot/config.json` with mode `0600`.
7. `connect` preserves unknown top-level configuration keys.

Test both URL forms:

```ts
expect(isReservedExampleUrl("git@company.example:platform/mycompany-wagglebot.git")).toBe(true);
expect(isReservedExampleUrl("https://company.example/platform/mycompany-wagglebot.git")).toBe(true);
```

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/cli/src/company-url.test.ts packages/cli/src/commands/connect.test.ts packages/cli/src/paths.test.ts`

Expected: FAIL because the modules and paths do not exist.

- [ ] **Step 3: Implement URL resolution and connection storage**

Extend `WagglePaths` with:

```ts
configFile: join(stateDir, "config.json"),
companyDir: join(stateDir, "company"),
activeCompanyDir: join(stateDir, "company", "active"),
runtimeDir: join(stateDir, "runtime"),
```

Add this exact official package metadata:

```json
"wagglebot": {
  "companyRepository": "git@company.example:platform/mycompany-wagglebot.git"
}
```

Use `writeFileAtomic` for the config and apply mode `0600`. Store no credential and perform no clone in `connect`.

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/company-url.test.ts packages/cli/src/commands/connect.test.ts packages/cli/src/paths.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/package.json packages/cli/src/paths.ts packages/cli/src/paths.test.ts packages/cli/src/company-url.ts packages/cli/src/company-url.test.ts packages/cli/src/commands/connect.ts packages/cli/src/commands/connect.test.ts
git commit -m "Add company repository connection settings"
```

---

## Task 3: Build a validated company cache with stale fallback

**Files:**

- Create: `packages/cli/src/company-cache.ts`
- Create: `packages/cli/src/company-cache.test.ts`
- Modify: `packages/cli/src/exec.ts`
- Modify: `packages/cli/src/exec.test.ts`

**Interfaces:**

```ts
export type CompanyCacheResult = {
  root: string;
  refreshFailed: boolean;
  warning?: string;
};

export function validateCompanyBase(root: string): {
  pin: string;
  company: CompanyRepo;
};

export async function refreshCompanyCache(input: {
  url: string;
  paths: WagglePaths;
  exec: Exec;
}): Promise<CompanyCacheResult>;
```

- [ ] **Step 1: Write failing cache tests with a local bare Git remote**

Create a temporary source repository and bare remote. Test:

- The first refresh clones and activates a valid candidate.
- A later valid revision replaces the active cache.
- A candidate without `wagglebot.yaml` never replaces the active cache.
- A candidate with no `company/` never replaces the active cache.
- A range, tag, workspace reference, or `file:` pin fails base validation.
- A failed refresh returns the previous active cache and sets `refreshFailed: true`.
- A failed first refresh throws and does not provision.

The exact pin expression is:

```ts
const EXACT_PIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
```

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/cli/src/company-cache.test.ts packages/cli/src/exec.test.ts`

Expected: FAIL because the cache module does not exist.

- [ ] **Step 3: Implement candidate activation**

Use these cache rules:

1. Clone into an empty temporary directory under `~/.wagglebot/company/`.
2. Validate the marker, exact pin, and company layer before activation.
3. Rename the valid candidate to an immutable directory under `company/revisions/`.
4. Create an `active.next` relative symlink to that revision.
5. Rename the symlink over `active` as the atomic activation step.
6. Keep the prior revision until activation succeeds.
7. Remove only temporary paths and inactive revisions that this run owns.

Use symlinks only on macOS and Linux, including WSL. Native Windows remains out of scope. Add a rollback test that injects an activation failure and keeps the old `active` link usable.

Extend `Exec` options with an optional `env`. Preserve the current default environment when no override exists. This supports later runtime tests without changing the real process environment.

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/company-cache.test.ts packages/cli/src/exec.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/company-cache.ts packages/cli/src/company-cache.test.ts packages/cli/src/exec.ts packages/cli/src/exec.test.ts
git commit -m "Add the validated company cache"
```

---

## Task 4: Install and execute the pinned Wagglebot runtime

**Files:**

- Create: `packages/cli/src/pinned-runtime.ts`
- Create: `packages/cli/src/pinned-runtime.test.ts`

**Interfaces:**

```ts
export type PinnedRuntime = { version: string; bin: string };

export async function ensurePinnedRuntime(input: {
  pin: string;
  runtimeDir: string;
  exec: Exec;
}): Promise<PinnedRuntime>;

export async function runPinnedRuntime(input: {
  runtime: PinnedRuntime;
  argv: string[];
  companyRoot: string;
  sourceFailed?: boolean;
  exec: Exec;
  write: (line: string) => void;
}): Promise<number>;
```

- [ ] **Step 1: Write failing install and re-execution tests**

Prove that:

- An installed version reuses `~/.wagglebot/runtime/<version>/`.
- A missing version runs one normal npm install.
- A failed npm install returns a required failure.
- An incomplete runtime is not accepted.
- The child command uses `process.execPath` and the installed `bin/wagglebot.js`.
- The child receives hidden `--company-root <active-cache>` and `--pinned-runtime <version>` arguments.
- A stale-cache run also receives hidden `--source-failed` state.
- The bootstrap forwards stdout, stderr, and the child exit code.

The npm call must have this shape:

```ts
await exec("npm", [
  "install",
  "--prefix",
  candidateRuntime,
  "--no-save",
  "--no-package-lock",
  `wagglebot@${pin}`,
]);
```

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/cli/src/pinned-runtime.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement atomic runtime installation**

Install into a temporary version directory. Verify `node_modules/wagglebot/bin/wagglebot.js`, then rename the directory into place. Never replace the global npm package. Never run `npm install` during the test phase unless a fake `Exec` captures it.

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/pinned-runtime.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/pinned-runtime.ts packages/cli/src/pinned-runtime.test.ts
git commit -m "Run company updates with the pinned runtime"
```

---

## Task 5: Expand the capability table to nine harnesses

**Files:**

- Modify: `packages/cli/src/harness.ts`
- Modify: `packages/cli/src/harness.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/help.ts`
- Modify: `packages/cli/src/commands/update.ts`
- Modify: `packages/cli/src/commands/install-skills.ts`
- Modify: `packages/cli/src/commands/install-agents.ts`
- Modify: `packages/cli/src/commands/sync-agents.ts`
- Modify: `packages/cli/src/commands/write-mcp.ts`
- Delete: `packages/cli/src/harness-select.ts`
- Delete: `packages/cli/src/harness-select.test.ts`

**Capability shape:**

```ts
export type Harness = {
  name: string;
  skillsAgents: string[];
  templateTargets: string[];
  hookTargets: HookTarget[];
  mcpTargets: McpTarget[];
  subagentDirs: string[];
  projectTarget?: ProjectTarget;
};

export type HookTarget =
  | { format: "settings-json"; path: string; fragmentFile: string }
  | { format: "owned-json-file"; path: string; fragmentFile: string };
```

- [ ] **Step 1: Write the failing nine-harness table test**

Assert this exact order:

```ts
expect(HARNESSES.map((h) => h.name)).toEqual([
  "claude-code",
  "codex",
  "junie",
  "gemini",
  "copilot",
  "cline",
  "cursor",
  "devin",
  "kiro",
]);
```

Also assert the new targets:

| Harness | Global instructions | Skills agent | Custom agents | Hooks | MCP |
|---|---|---|---|---|---|
| Gemini | `.gemini/GEMINI.md` | `gemini-cli` | `.gemini/agents` | `.gemini/settings.json` | `.gemini/settings.json` |
| Copilot | `.copilot/copilot-instructions.md` | `github-copilot` | `.copilot/agents` | `.copilot/hooks/wagglebot.json` | `.copilot/mcp-config.json` |
| Cursor | `.cursor/rules/wagglebot.mdc` | `cursor` | `.cursor/agents` | `.cursor/hooks.json` | `.cursor/mcp.json` |
| Devin | `.config/devin/AGENTS.md`, `.codeium/windsurf/memories/global_rules.md` | `devin`, `windsurf` | `.config/devin/agents` | `.config/devin/config.json`, `.codeium/windsurf/hooks.json` | `.config/devin/mcp_config.json`, `.codeium/windsurf/mcp_config.json` |
| Kiro | `.kiro/steering/AGENTS.md` | `kiro-cli` | `.kiro/agents` | `.kiro/hooks/wagglebot.json` | `.kiro/settings/mcp.json` |

Cursor, Devin, and Kiro use root `AGENTS.md` for project instructions.

- [ ] **Step 2: Run the focused test**

Run: `bun test packages/cli/src/harness.test.ts`

Expected: FAIL because the table has six harnesses and singular capability fields.

- [ ] **Step 3: Implement the table and remove selection**

Convert all existing entries to the array shape. Remove `detectDir` and `wagglebot.harnesses`. Delete selection code. Callers must use `HARNESSES` directly and must create target directories as needed.

Update each existing caller mechanically in this task. Preserve its current behavior beyond iteration over arrays. This keeps the repository type-correct before later behavior changes.

Use these new MCP dialect names:

```ts
export type McpDialect =
  | "claude"
  | "codex"
  | "gemini"
  | "copilot"
  | "cline"
  | "junie"
  | "cursor"
  | "devin"
  | "windsurf"
  | "kiro";
```

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/harness.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/harness.ts packages/cli/src/harness.test.ts packages/cli/src/index.ts packages/cli/src/help.ts packages/cli/src/commands/update.ts packages/cli/src/commands/install-skills.ts packages/cli/src/commands/install-agents.ts packages/cli/src/commands/sync-agents.ts packages/cli/src/commands/write-mcp.ts packages/cli/src/harness-select.ts packages/cli/src/harness-select.test.ts
git commit -m "Support nine harness capability adapters"
```

---

## Task 6: Implement project `init` and project `update`

**Files:**

- Rename: `packages/cli/src/commands/sync-project.ts` to `packages/cli/src/commands/project-update.ts`
- Rename: `packages/cli/src/commands/sync-project.test.ts` to `packages/cli/src/commands/project-update.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/help.ts`
- Create: `packages/cli/src/commands/project-init.ts`
- Create: `packages/cli/src/commands/project-init.test.ts`
- Create: `packages/cli/templates/agent-changelog.md`
- Modify: `packages/cli/templates/component-memory.md`
- Modify: `packages/cli/templates/AGENTS.base.md`
- Modify: `skills/onboarding-a-repository/SKILL.md`
- Modify: `packages/cli/e2e/first-party-skills.test.ts`

**Interfaces:**

```ts
export const PROJECT_INSTRUCTIONS_DIR = ".agents/instructions";
export const PROJECT_MEMORY_FILE = ".agents/memory.md";
export const PROJECT_CHANGELOG_FILE = ".agents/changelog.md";

export function runProjectUpdate(input: {
  cwd: string;
  reporter: Reporter;
  harnesses?: Harness[];
}): number;

export function runProjectInit(input: {
  cwd: string;
  reporter: Reporter;
}): number;
```

- [ ] **Step 1: Write failing project lifecycle tests**

Cover these cases:

- `project init` creates `.agents/instructions/`, `memory.md`, and `changelog.md`.
- `project init` performs the first project update.
- `project update` creates missing memory and changelog files with no instruction sources.
- Both commands preserve existing memory and changelog content byte for byte.
- Neither command adds memory or changelog to `.gitignore`.
- Neither command creates `catalog-info.yaml`.
- The generated instruction note names `wagglebot update`, not `sync-project`.
- Root `AGENTS.md` serves Codex, Junie, Cline, Cursor, Devin, and Kiro.
- Claude, Gemini, and Copilot keep their existing vendor targets.
- Personal text outside each managed block survives.
- Memory, changelog, and `.agents/subagents/` text never appears in a published instruction target.

Use this changelog template:

```md
# Agent Changelog

<!-- Add dated Added, Changed, Fixed, or Removed sections after meaningful repository changes. -->
```

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/cli/src/commands/project-update.test.ts packages/cli/src/commands/project-init.test.ts`

Expected: FAIL because project initialization and the changelog template do not exist.

- [ ] **Step 3: Implement project lifecycle behavior**

Make `runProjectUpdate` create only missing memory and changelog files before it publishes instructions. Do not derive instructions from these files. Keep the current all-target preflight before any instruction mutation.

Make `runProjectInit` require a Git repository. Create missing files only, then call `runProjectUpdate`.

Update router and help imports when the module and constant names change. Preserve the existing `sync-project` route. Task 11 makes it a hidden alias.

Add an `## Agent Changelog` section to `AGENTS.base.md`. Require concise dated bullets after durable changes. Exclude research, failed attempts, and no-change sessions. Remove the Phase 2 `## Local Repository Brain` section from the Phase 1 base template. Keep the direct `.agents/memory.md` contract.

Update the repository onboarding skill. It must ask for the component owner and system before it writes `catalog-info.yaml`. It must not guess either value from a directory or Git remote.

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/commands/project-update.test.ts packages/cli/src/commands/project-init.test.ts packages/cli/src/template.test.ts packages/cli/e2e/first-party-skills.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/commands/project-update.ts packages/cli/src/commands/project-update.test.ts packages/cli/src/commands/project-init.ts packages/cli/src/commands/project-init.test.ts packages/cli/src/index.ts packages/cli/src/help.ts packages/cli/templates/agent-changelog.md packages/cli/templates/component-memory.md packages/cli/templates/AGENTS.base.md packages/cli/src/commands/sync-project.ts packages/cli/src/commands/sync-project.test.ts skills/onboarding-a-repository/SKILL.md packages/cli/e2e/first-party-skills.test.ts
git commit -m "Add project initialization and updates"
```

---

## Task 7: Synchronize global instructions and vendor hook formats

**Files:**

- Rename: `packages/cli/src/commands/sync-agents.ts` to `packages/cli/src/commands/sync-harnesses.ts`
- Rename: `packages/cli/src/commands/sync-agents.test.ts` to `packages/cli/src/commands/sync-harnesses.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/managed-json.ts`
- Modify: `packages/cli/src/managed-json.test.ts`
- Modify: `packages/cli/templates/hooks/claude-code.json`
- Create: `packages/cli/templates/hooks/gemini.json`
- Create: `packages/cli/templates/hooks/copilot.json`
- Create: `packages/cli/templates/hooks/cursor.json`
- Create: `packages/cli/templates/hooks/devin.json`
- Create: `packages/cli/templates/hooks/windsurf.json`
- Create: `packages/cli/templates/hooks/kiro.json`

**Interface change:**

```ts
export function runSyncHarnesses(input: {
  home: string;
  harnesses: Harness[];
  instructionDirs: string[];
  reporter: Reporter;
  overwriteLocal?: boolean;
  backups?: BackupSet;
  fragmentsDir?: string;
}): number;
```

- [ ] **Step 1: Write failing preservation, format, and overwrite tests**

Prove that default mode:

- Creates every global instruction directory and file.
- Preserves personal text outside managed instruction blocks.
- Preserves foreign hook entries in settings JSON.
- Writes Gemini CLI hooks under `hooks.AfterTool` in `.gemini/settings.json`.
- Writes a Copilot CLI v1 owned file with `postToolUse` in `.copilot/hooks/wagglebot.json`.
- Writes Cursor hooks under `hooks.afterFileEdit`.
- Writes Devin CLI hooks under the `hooks` key in `.config/devin/config.json`.
- Writes Cascade hooks under `hooks.post_write_code`.
- Writes the Kiro v1 owned file with `PostFileSave` and a Markdown matcher.
- Reports hooks as unsupported for Codex, Junie, and Cline while their global instructions contain the same durable rules.
- Continues when one target contains malformed JSON.

Prove that overwrite mode:

- Replaces each dedicated instruction file with rendered Wagglebot instructions.
- Replaces the complete `hooks` category in shared settings JSON.
- Replaces the Copilot owned hook file.
- Preserves unrelated keys such as `theme`, `model`, and `keybindings`.
- Replaces the Kiro owned hook file.
- Creates no backup directory.

Add this helper to `managed-json.ts`:

```ts
export function replaceJsonCategory(
  existingText: string,
  key: string,
  value: unknown,
): { next: string; changed: boolean };
```

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/cli/src/commands/sync-harnesses.test.ts packages/cli/src/managed-json.test.ts`

Expected: FAIL because only the Claude hook format and managed merge mode exist.

- [ ] **Step 3: Implement hook strategies and overwrite behavior**

Keep hook actions deterministic. Do not use prompt hooks that invoke an LLM. Each hook reminds the active agent to apply prose rules and update `.agents/changelog.md` after a durable change.

Use these vendor mappings:

- Claude Code and Devin CLI: `PostToolUse` with a write/edit matcher.
- Gemini CLI: `AfterTool` in the user `settings.json` file.
- Copilot CLI: an owned v1 JSON file with `postToolUse`.
- Cursor: `afterFileEdit`.
- Cascade: `post_write_code`.
- Kiro: an owned v1 JSON file with `PostFileSave` and `\\.md$`.

In default mode, create one backup set for changed files. In overwrite mode, never create or call a backup set.

Update the router import when the module name changes. Preserve the existing `sync-agents` route. Task 11 adds `sync-harnesses` and hides the alias.

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/commands/sync-harnesses.test.ts packages/cli/src/managed-json.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/index.ts packages/cli/src/commands/sync-harnesses.ts packages/cli/src/commands/sync-harnesses.test.ts packages/cli/src/managed-json.ts packages/cli/src/managed-json.test.ts packages/cli/templates/hooks packages/cli/src/commands/sync-agents.ts packages/cli/src/commands/sync-agents.test.ts
git commit -m "Synchronize instructions and hooks for nine harnesses"
```

---

## Task 8: Install skills and custom agents for every compatible harness

**Files:**

- Modify: `packages/cli/src/commands/install-skills.ts`
- Modify: `packages/cli/src/commands/install-skills.test.ts`
- Modify: `packages/cli/src/commands/install-agents.ts`
- Modify: `packages/cli/src/commands/install-agents.test.ts`
- Modify: `packages/cli/src/state.ts`
- Modify: `packages/cli/src/state.test.ts`
- Create: `packages/cli/e2e/skills-adapters.test.ts`

**Interface changes:**

```ts
// runInstallSkills
overwriteLocal?: boolean;

// runInstallAgents
overwriteLocal?: boolean;
backups?: BackupSet;
```

- [ ] **Step 1: Write failing all-harness and overwrite tests**

For skills, assert the exact adapters:

```ts
[
  "claude-code",
  "codex",
  "junie",
  "gemini-cli",
  "github-copilot",
  "cline",
  "cursor",
  "devin",
  "windsurf",
  "kiro-cli",
]
```

Test that overwrite mode runs this once per adapter before installation:

```ts
[skillsBin, "remove", "--skill", "*", "--global", "--yes", "--agent", agent]
```

In `skills-adapters.test.ts`, run the installed `skills` 1.5.23 binary against every adapter. Use a temporary `HOME` and this offline command:

```sh
skills ls --global --agent <adapter> --json
```

Require exit code zero for each declared adapter. Also require a nonzero exit for one invalid control identifier. This proves the real dependency accepts the adapter names.

This exact invocation was verified against the installed `skills` 1.5.23 package on 2026-09-21. Recheck the command if the pinned package version changes.

For custom agents, test all declared `subagentDirs`. Default mode removes only state-owned stale files. Overwrite mode removes the exact dedicated agent directories, recreates them, installs the effective set, and creates no backup.

Assert that Codex and Cline report custom agents as unsupported. Other supported work for those harnesses must continue.

Also test a clone failure followed by a successful local agent install. The command must finish all independent work and return failure.

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/cli/src/commands/install-skills.test.ts packages/cli/src/commands/install-agents.test.ts packages/cli/src/state.test.ts packages/cli/e2e/skills-adapters.test.ts`

Expected: FAIL because the installers use singular adapters and have no overwrite mode.

- [ ] **Step 3: Implement category replacement**

For skill overwrite, remove skills only from the explicitly listed global adapters. Do not use `--agent '*'` or `--all`.

For custom-agent overwrite, validate each target as a home-relative dedicated directory before removal. Reject an empty path, `.`, `..`, an absolute path, or any target outside `home`.

Reset the matching managed state after the category clear. Continue with the normal install so the final state records only effective content.

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/commands/install-skills.test.ts packages/cli/src/commands/install-agents.test.ts packages/cli/src/state.test.ts packages/cli/e2e/skills-adapters.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/commands/install-skills.ts packages/cli/src/commands/install-skills.test.ts packages/cli/src/commands/install-agents.ts packages/cli/src/commands/install-agents.test.ts packages/cli/src/state.ts packages/cli/src/state.test.ts packages/cli/e2e/skills-adapters.test.ts
git commit -m "Install skills and agents across all harnesses"
```

---

## Task 9: Add Cursor, Devin, Cascade, and Kiro MCP dialects

**Files:**

- Modify: `packages/cli/src/mcp-dialects.ts`
- Modify: `packages/cli/src/mcp-dialects.test.ts`
- Modify: `packages/cli/src/commands/write-mcp.ts`
- Modify: `packages/cli/src/commands/write-mcp.test.ts`
- Modify: `packages/cli/src/managed-json.ts`
- Modify: `packages/cli/src/managed-json.test.ts`

**Dialect rules:**

| Dialect | HTTP/SSE | Safe variable syntax | Required shape |
|---|---|---|---|
| Cursor | Both through `url` | `${env:NAME}` | `type: "stdio"` for local entries |
| Devin CLI | `url` plus `transport` | `${env:NAME}` | `transport: "http"` or `"sse"` for remote entries |
| Cascade | Both through `url` | None documented | Skip credentialed entries |
| Kiro | Both through `url` | `${NAME}` | `command` for local entries |

- [ ] **Step 1: Write failing dialect and target tests**

For each new dialect, cover:

- A plain stdio server.
- A stdio server with environment values.
- Streamable HTTP without authentication.
- SSE without authentication.
- Bearer and custom-header credentials.
- A missing current environment value that still writes a safe reference and warns.
- An unsupported credential form that skips only one entry.

Test exact safe references:

```ts
expect(cursor.entry).toMatchObject({ env: { TOKEN: "${env:TOKEN}" } });
expect(devin.entry).toMatchObject({ headers: { Authorization: "Bearer ${env:TOKEN}" } });
expect(kiro.entry).toMatchObject({ headers: { Authorization: "Bearer ${TOKEN}" } });
```

Add overwrite tests that replace the full `mcpServers` category but preserve unrelated JSON settings. Add a Codex test that removes every foreign `[mcp_servers.*]` table while preserving unrelated TOML tables.

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/cli/src/mcp-dialects.test.ts packages/cli/src/commands/write-mcp.test.ts packages/cli/src/managed-json.test.ts`

Expected: FAIL because the dialects and overwrite writer do not exist.

- [ ] **Step 3: Implement MCP rendering and overwrite mode**

Add one variable conversion helper:

```ts
const variable = (name: string, style: "plain" | "env") =>
  style === "env" ? `\${env:${name}}` : `\${${name}}`;
```

Do not interpolate the current secret value. Use the current environment only to report a missing-variable warning.

Change `runWriteMcp` to iterate every `mcpTargets` entry. In default mode, keep state-owned key merges. In overwrite mode, set `mcpServers` to the effective object and clear all Codex `mcp_servers` tables before adding the managed block. Preserve unrelated JSON keys and unrelated TOML tables. Do not create backups in overwrite mode.

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/mcp-dialects.test.ts packages/cli/src/commands/write-mcp.test.ts packages/cli/src/managed-json.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/mcp-dialects.ts packages/cli/src/mcp-dialects.test.ts packages/cli/src/commands/write-mcp.ts packages/cli/src/commands/write-mcp.test.ts packages/cli/src/managed-json.ts packages/cli/src/managed-json.test.ts
git commit -m "Write safe MCP configs for nine harnesses"
```

---

## Task 10: Resolve company layers and run every provisioning stage

**Files:**

- Modify: `packages/cli/src/identity.ts`
- Modify: `packages/cli/src/identity.test.ts`
- Create: `packages/cli/src/company-context.ts`
- Create: `packages/cli/src/company-context.test.ts`
- Rename: `packages/cli/src/commands/update.ts` to `packages/cli/src/commands/provision-company.ts`
- Rename: `packages/cli/src/commands/update.test.ts` to `packages/cli/src/commands/provision-company.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/commands/sync-shell.ts`
- Modify: `packages/cli/src/commands/sync-shell.test.ts`

**Interfaces:**

```ts
export type ResolvedCompanyContext = {
  company: CompanyRepo;
  username: string;
  teams: string[];
  layers: Layer[];
  catalogFailed: boolean;
};

export async function resolveCompanyContext(input: {
  root: string;
  exec: Exec;
  ask: Ask;
  reporter: Reporter;
}): Promise<ResolvedCompanyContext>;

export async function runCompanyProvision(input: {
  companyRoot: string;
  home: string;
  exec: Exec;
  ask: Ask;
  reporter: Reporter;
  write: (line: string) => void;
  skillsBin?: string;
  env?: NodeJS.ProcessEnv;
  overwriteLocal?: boolean;
  sourceFailed?: boolean;
}): Promise<number>;
```

- [ ] **Step 1: Write failing catalog, identity, and continuation tests**

Cover these cases:

- A missing `wagglebot.username` prompts once and stores the answer.
- Identity collection works when no catalog exists.
- No catalog selects only the company layer and reports a warning.
- An unknown username selects only the company layer and reports a warning.
- A known user receives every applicable team layer.
- An invalid catalog selects only the company layer, reports an error, continues provisioning, and returns failure.
- A team directory absent from a valid catalog has the same invalid-catalog behavior.
- A skills failure does not stop agents, instructions, shell, or MCP stages.
- A malformed config for one harness does not stop other harnesses.
- `sourceFailed: true` provisions from stale cache and forces a failure exit.
- Default mode shares one backup set. Overwrite mode creates none.
- Overwrite mode updates the managed shell block without creating a shell backup.

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/cli/src/identity.test.ts packages/cli/src/company-context.test.ts packages/cli/src/commands/provision-company.test.ts packages/cli/src/commands/sync-shell.test.ts`

Expected: FAIL because identity requires a valid catalog and the current update stops early.

- [ ] **Step 3: Separate context resolution from provisioning**

Change `getUsername` so it only reads, asks, and stores the Git username. Move catalog membership checks into `resolveCompanyContext`.

Resolve layers in this order:

```ts
const layers = [company.company, ...company.teams.filter((team) => teams.includes(team.name))];
```

Catch catalog parse and relationship errors. Record one failed report item and return the company layer. Do not let a catalog error block the stable base.

Make `runCompanyProvision` run all five stages in order. Catch a thrown stage error, report it, and continue. Use `HARNESSES` for every stage. Print one summary only after all stages finish.

The summary must count and name `ok`, `updated`, `skipped`, `warned`, and `failed` items. A required failure must set the final exit code after all safe work finishes.

Let `runSyncShell` accept `backups: false`. In that mode, update only its managed block and never initialize a backup set. Company overwrite mode must pass this value.

Update the router import when the command module name changes. Preserve the public `update` command name.

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/identity.test.ts packages/cli/src/company-context.test.ts packages/cli/src/commands/provision-company.test.ts packages/cli/src/commands/sync-shell.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/identity.ts packages/cli/src/identity.test.ts packages/cli/src/company-context.ts packages/cli/src/company-context.test.ts packages/cli/src/index.ts packages/cli/src/commands/provision-company.ts packages/cli/src/commands/provision-company.test.ts packages/cli/src/commands/update.ts packages/cli/src/commands/update.test.ts packages/cli/src/commands/sync-shell.ts packages/cli/src/commands/sync-shell.test.ts
git commit -m "Provision the stable company and team layers"
```

---

## Task 11: Route the simple public command model

**Files:**

- Rename: `packages/cli/src/commands/init.ts` to `packages/cli/src/commands/company-init.ts`
- Rename: `packages/cli/src/commands/init.test.ts` to `packages/cli/src/commands/company-init.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/index.test.ts`
- Modify: `packages/cli/src/help.ts`
- Modify: `packages/cli/src/help.test.ts`
- Modify: `packages/cli/templates/init/package.json`
- Create: `packages/cli/templates/init/wagglebot.yaml`

**Injected CLI dependencies:**

```ts
export type CliDeps = {
  write: (line: string) => void;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  ask?: Ask;
  skillsBin?: string;
  packageMetadata?: PackageMetadata;
  brain?: LocalBrain;
};
```

- [ ] **Step 1: Write failing command-routing tests**

Test this matrix:

| Command | Normal project | Marked company working tree | `--wagglebot` outside company tree |
|---|---|---|---|
| `init` | Project init | Project init | Company scaffold |
| `update` | Project update | Working-tree company provision | Refresh, pin, and cached provision |
| Lower-level company command | Clear `--wagglebot` error | Working-tree company source | Active company cache |

Also prove:

- `connect <git-url>` works outside a Git repository.
- `init --wagglebot [directory]` writes `wagglebot.yaml`.
- Plain company `update` includes uncommitted working-tree files and does not refresh Git.
- Plain company `update` uses the current CLI process and never installs or re-executes the repository pin.
- `update --wagglebot` resolves URL precedence, refreshes cache, installs the pin, and re-executes once.
- A failed refresh re-executes with `--source-failed`, provisions the stale cache, and returns failure.
- A lower-level command with `--wagglebot` selects the active cache pin before it runs.
- Hidden internal runtime arguments do not appear in help.
- `--overwrite-local` fails in project mode.
- `--overwrite-local` reaches company provision in working-tree and cached modes.
- `sync-project` calls project update but is absent from general help.
- `sync-agents` calls `sync-harnesses` but is absent from general help.
- General help contains no `wagglebot.harnesses` setting.
- Lower-level company commands remain visible.

- [ ] **Step 2: Run the focused tests**

Run: `bun test packages/cli/src/index.test.ts packages/cli/src/help.test.ts packages/cli/src/commands/company-init.test.ts`

Expected: FAIL because `init` and `update` still have company-only meanings.

- [ ] **Step 3: Implement one router with explicit bootstrap boundaries**

Use these rules:

1. Parse `connect` before any Git-root lookup.
2. Parse `init --wagglebot` as company scaffold mode.
3. For plain `update` in a marked company repository, use the current process and working tree. Do not install or re-execute the pin.
4. For `update --wagglebot`, refresh the cache before runtime selection.
5. For hidden `--company-root`, skip refresh and runtime selection, then provision that validated root.
6. For lower-level `--wagglebot`, use the active cache and its exact pin. Re-execute with that pinned runtime before the command runs.
7. If the active cache is absent, ask for `wagglebot update --wagglebot`.
8. Pass hidden `--source-failed` state through the pinned child. The final provisioning result must remain a failure after stale-cache success.

Keep `brain` commands callable, but describe them outside the Phase 1 workflow. Do not call them from `init` or `update`.

Company scaffold output must include:

```yaml
version: 1
kind: company
```

Rewrite help from the public workflow first. The overwrite help must name each instruction file, skill target, agent directory, hook category, and MCP category it replaces.

- [ ] **Step 4: Verify the task**

Run: `bun test packages/cli/src/index.test.ts packages/cli/src/help.test.ts packages/cli/src/commands/company-init.test.ts && bun run check && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/index.ts packages/cli/src/index.test.ts packages/cli/src/help.ts packages/cli/src/help.test.ts packages/cli/src/commands/company-init.ts packages/cli/src/commands/company-init.test.ts packages/cli/src/commands/init.ts packages/cli/src/commands/init.test.ts packages/cli/templates/init/package.json packages/cli/templates/init/wagglebot.yaml
git commit -m "Route project and company commands"
```

---

## Task 12: Make `test-app` the complete offline Phase 1 drift gate

**Files:**

- Modify: `scripts/regen-test-app.mjs`
- Modify: `test-app/**`
- Modify: `packages/cli/e2e/helper.ts`
- Replace: `packages/cli/e2e/provisioning.test.ts`
- Replace: `packages/cli/e2e/sync-project.test.ts`
- Modify: `packages/cli/e2e/scaffold.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the failing end-to-end expectations**

The company E2E test must:

1. Build the real CLI.
2. Copy `test-app/` into a temporary directory.
3. Initialize and commit the copied fixture as a Git repository.
4. Create local tagged Git repositories for one skill and one custom agent.
5. Rewrite the copied lists to those local remotes and commit that test setup.
6. Set temporary `HOME`, `GIT_CONFIG_GLOBAL`, and `SHELL` values.
7. Store username `alice` in the temporary global Git config.
8. Run real plain `wagglebot update` inside the marked working tree.
9. Verify global instructions, skills, agents, hooks, shell, and MCP output for all nine harnesses.
10. Run the same command again and require only idempotent results.
11. Require `git status --porcelain` to remain empty.

The project E2E test must run real `wagglebot init` in a temporary Git repository. Verify memory, changelog, all project instruction targets, preservation, and second-run idempotency.

- [ ] **Step 2: Run the E2E tests**

Run: `bun test packages/cli/e2e/provisioning.test.ts packages/cli/e2e/sync-project.test.ts packages/cli/e2e/scaffold.test.ts`

Expected: FAIL because current provisioning detects one harness and the fixture has no marker.

- [ ] **Step 3: Regenerate and complete the fixture**

Update scaffold generation first. Run:

```sh
bun run regen:test-app
```

Commit these fixture properties:

- Root `wagglebot.yaml` marker.
- Exact Wagglebot pin in `package.json`.
- Company instructions, local agents, registry, and credential example.
- One valid team catalog and team layer.
- No real credential.
- No network-only test source.

Keep normal npm registry access in the dependency-install phase of CI. After install, run tests without a service, harness binary, LLM, or network fixture.

Keep the Node.js 22 and 24 package smoke checks. Run the same built CLI artifact in both checks. Do not install or start any supported harness.

Add explicit CI steps after `bun test`:

```sh
bun run regen:test-app
git diff --exit-code -- test-app
```

These steps make fixture drift a named GitHub Actions gate instead of relying only on test discovery.

- [ ] **Step 4: Verify the drift gate**

Run:

```sh
bun test packages/cli/e2e
bun run regen:test-app
git diff --exit-code -- test-app
git status --short
```

Expected: E2E tests pass. Regeneration produces no test-app difference. Only this task's intended files remain modified before commit.

- [ ] **Step 5: Commit**

```sh
git add scripts/regen-test-app.mjs test-app packages/cli/e2e .github/workflows/ci.yml
git commit -m "Verify Phase 1 through the offline test app"
```

---

## Task 13: Update onboarding, migration, and harness documentation

**Files:**

- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `docs/harnesses.md`
- Create: `docs/phase-1-onboarding.md`
- Create: `docs/phase-1-command-migration.md`
- Modify: `test-app/README.md`
- Modify: relevant Phase 1 status links in `docs/superpowers/specs/2026-08-28-wagglebot-design.md`

- [ ] **Step 1: Write or update documentation assertions**

Extend `packages/cli/src/help.test.ts` and `packages/cli/src/harness.test.ts` to check:

- The nine harness names appear in the reference.
- `connect`, project `init`, project `update`, and `update --wagglebot` appear in onboarding.
- Hidden aliases do not appear in primary help.
- Package metadata contains the exact official `.example` repository URL.
- Documentation identifies `.example` hosts as reserved and never fetchable.
- Native Windows remains explicitly unsupported.
- No Phase 1 text tells engineers to clone the company repository.

- [ ] **Step 2: Run documentation tests**

Run: `bun test packages/cli/src/help.test.ts packages/cli/src/harness.test.ts packages/cli/src/template.test.ts`

Expected: FAIL until documentation and help agree with the new workflow.

- [ ] **Step 3: Update documentation**

Document the engineer flow:

```sh
npm install --global wagglebot@<version>
wagglebot connect <company-git-url>   # optional for a company package with a real default
wagglebot update --wagglebot
cd my-project
wagglebot init
wagglebot update
```

Document the administrator flow:

```sh
wagglebot init --wagglebot mycompany-wagglebot
cd mycompany-wagglebot
wagglebot update
```

Explain that the administrator command uses uncommitted working-tree changes. Explain that engineers run the explicit company update after an announcement.

In `docs/harnesses.md`, record each verified path, format, feature skip, and primary vendor source. State that Devin support is local only. Describe both Devin CLI and Cascade targets inside Devin Desktop.

In the migration document, map:

- `sync-project` to project `update`.
- `sync-agents` to `sync-harnesses`.
- Visible company clones to `connect` plus cache.
- Harness selection to automatic all-harness provisioning.

- [ ] **Step 4: Run full verification**

Run:

```sh
bun test
bun run check
bun run typecheck
bun run build
bun run regen:test-app
git diff --exit-code -- test-app
npm pack --dry-run
```

Run `npm pack --dry-run` from `packages/cli/`.

Expected:

- All tests pass.
- Biome adds no new warning.
- TypeScript reports no error.
- The CLI builds.
- The fixture has no drift.
- The package contains `bin/`, `dist/`, `templates/`, and `README.md`.

- [ ] **Step 5: Audit specification coverage**

Search for stale public workflow terms:

```sh
rg -n "wagglebot\.harnesses|git clone <company repo>|yarn update:wagglebot|sync-project|sync-agents" README.md packages/cli/README.md docs packages/cli/src/help.ts
```

Keep only deliberate migration notes and hidden alias tests.

Review every bullet in `docs/superpowers/specs/2026-09-21-phase-1-polish-design.md`. Link each requirement to a passing test or documentation section. Add missing coverage before completion.

- [ ] **Step 6: Commit**

```sh
git add README.md packages/cli/README.md docs/harnesses.md docs/phase-1-onboarding.md docs/phase-1-command-migration.md test-app/README.md docs/superpowers/specs/2026-08-28-wagglebot-design.md packages/cli/src/help.test.ts packages/cli/src/harness.test.ts
git commit -m "Document the polished Phase 1 workflow"
```

---

## Final Acceptance Checklist

- [ ] `wagglebot connect` stores only a repository URL.
- [ ] A real internal package URL makes `connect` optional.
- [ ] The official `.example` URL is never fetched.
- [ ] Cached updates run the exact company pin.
- [ ] A broken refresh uses the last valid cache and returns failure.
- [ ] Plain update in a marked company repository uses the working tree.
- [ ] Project `init` and `update` need no company repository.
- [ ] All nine harnesses receive every compatible capability.
- [ ] Default updates preserve personal content.
- [ ] Overwrite mode replaces only the five named categories and creates no backup.
- [ ] Missing and unknown catalog cases succeed with warnings.
- [ ] Invalid catalogs provision the company layer and return failure.
- [ ] Credentials remain variable references or cause one safe MCP skip.
- [ ] Memory and changelog files remain committed and preserve user content.
- [ ] One harness or stage failure does not stop independent work.
- [ ] The complete E2E flow runs offline and never invokes an LLM.
- [ ] `test-app` stays clean after two real updates.
- [ ] Primary help shows only the approved public workflow and advanced company commands.
