# Phase 1 Gap Closure Implementation Plan (wagglebot 0.2.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every bug, partial item, and missing item that the 2026-09-09 gap analysis found between the Phase 1 spec and `packages/cli`, then release 0.2.0.

**Architecture:** Five file-disjoint work groups (A–E) run in parallel, each in its own git worktree and branch, one commit per fix or feature. The main session integrates the groups onto `claude/phase-1-gap-closure`, reviews, adds the `Prepare 0.2.0` commit, and opens the pull request. No new service, no new runtime dependency unless a task names one.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Bun 1.3 (test runner and bundler), Node 22+ at runtime, Biome 2.2, `yaml` (bundled), `skills` CLI 1.5.23 (runtime dependency).

**Spec:** `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md` (Phase 1), `docs/superpowers/specs/2026-08-28-wagglebot-design.md` (decisions D1–D37), `docs/superpowers/specs/2026-08-28-service-contracts.md` (§C6 pitfalls).

## Global Constraints

- Node `>=22.20.0` (`packages/cli/package.json` engines). The CLI bundles with `bun build src/index.ts --target=node --outdir dist`; `yaml` is bundled from devDependencies. Add no runtime dependency unless a task says so.
- Biome: 2-space indent, `lineWidth` 120, recommended rules. Run `bun run check` before every commit; the seven existing `noTemplateCurlyInString` warnings about `${VAR}` strings are accepted.
- TypeScript: `bun run typecheck` must pass. No `as` casts to silence a type error; narrow instead.
- Tests: `bun test`. A unit test sits next to its source as `<name>.test.ts`. End-to-end tests under `packages/cli/e2e/` run the built CLI. Write the failing test first, run it, then implement.
- Never write a secret to any file. A credential appears as `${VAR}` only (D10, F23).
- Never derive an identifier from repository layout or a Git remote. Declare it (P33, P35).
- Every mutation lands in a managed block or a recorded key. Content outside stays untouched (F22).
- Prose in docs, comments, help text, and skill text follows ASD-STE100: short sentences, active voice, imperative for procedures, no contractions.
- Commit messages: one imperative sentence, capitalized, no type prefix (match `git log --oneline`). A body is optional. End every message with a blank line and then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- One commit per fix or feature. `git add` only the files of the task.
- Each group works in its own worktree. Run `bun install --frozen-lockfile` once in the worktree before the first test.
- Do not edit `main`. Do not touch files owned by another group (see the file map).

---

## File Map

| Group | Owns (modify) | Creates |
|---|---|---|
| A | `packages/cli/src/commands/install-skills.ts`, `install-skills.test.ts`, `src/lists.ts`, `lists.test.ts`, `src/company.ts`, `company.test.ts`, `src/commands/update.ts`, `update.test.ts`, `src/index.ts`, `src/commands/install-agents.ts` (warnings loop only, lines 45 and the deps type) | — |
| B | `src/commands/sync-agents.ts`, `sync-agents.test.ts`, `src/managed-json.ts`, `managed-json.test.ts`, `src/commands/install-agents.ts` (lines 55–64 and 93 only), `install-agents.test.ts`, `src/backup.ts`, `backup.test.ts` | — |
| C | `src/commands/write-mcp.ts`, `write-mcp.test.ts`, `src/registry.ts`, `registry.test.ts`, `src/harness.ts`, `harness.test.ts`, `src/help.ts`, `help.test.ts`, `README.md` (the MCP line and the Documentation table), `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md` (MCP target table only) | `src/mcp-dialects.ts`, `mcp-dialects.test.ts`, `docs/harnesses.md` |
| D | `packages/cli/templates/init/**`, `src/commands/init.ts`, `init.test.ts`, `test-app/**` (regenerated), `docs/superpowers/specs/2026-08-28-wagglebot-design.md` (D33 row only), `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md` (sections "First-party skills (D33)" and "The bundled skill (D33)" only) | `skills/writing-a-custom-agent/SKILL.md`, `skills/adding-an-mcp-server/SKILL.md`, `skills/onboarding-a-repository/SKILL.md`, `packages/cli/e2e/first-party-skills.test.ts` |
| E | `docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md`, `docs/superpowers/specs/2026-08-28-service-contracts.md`, `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md` (sections "Agent Base Template + Distribution" and "Distribution" rule 1 only) | `packages/cli/src/exec.test.ts` |

Groups A and B both touch `install-agents.ts` in disjoint regions. Group A adds a warnings loop at line 45 and an `organization` field to the deps type. Group B changes `installFile` (lines 55–64) and the file filter at line 93. The integrator resolves any overlap.

---

## Group A — Skills installer, lists, update

### Task A1: `--update` rewrites one list line and keeps a branch pin

**Files:**
- Modify: `packages/cli/src/lists.ts`
- Modify: `packages/cli/src/commands/install-skills.ts:43-56, 76-98`
- Test: `packages/cli/src/lists.test.ts`, `packages/cli/src/commands/install-skills.test.ts`

**Why:** `text.replace(entry.raw, next)` at line 92 is a first-occurrence substring replace. A comment that mentions the entry above it, or a duplicate line, gets rewritten instead of the entry. The same loop also bumps a deliberate branch pin (`ayghri/i-have-adhd@main`, the seed entry) to a version tag.

**Interfaces:**
- Produces: `replaceListLine(text: string, raw: string, next: string): string` in `lists.ts`; `VERSION_TAG: RegExp` exported from `lists.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `lists.test.ts`:

```ts
import { replaceListLine, VERSION_TAG } from "./lists";

test("replaceListLine rewrites the entry line only and keeps its trailing comment", () => {
  const text = [
    "# obra/superpowers@v6.3.0 is the stable one",
    "obra/superpowers@v6.3.0   # keep me",
    "obra/superpowers@v6.3.0",
    "",
  ].join("\n");
  expect(replaceListLine(text, "obra/superpowers@v6.3.0", "obra/superpowers@v6.4.0")).toBe(
    [
      "# obra/superpowers@v6.3.0 is the stable one",
      "obra/superpowers@v6.4.0   # keep me",
      "obra/superpowers@v6.3.0",
      "",
    ].join("\n"),
  );
});

test("VERSION_TAG accepts version tags only", () => {
  expect(VERSION_TAG.test("v6.3.0")).toBe(true);
  expect(VERSION_TAG.test("6.3")).toBe(true);
  expect(VERSION_TAG.test("main")).toBe(false);
  expect(VERSION_TAG.test("1a2b3c4")).toBe(false);
});
```

Append to `install-skills.test.ts` (reuse `managed`, `NO_LOCK`, `NODE`, and `createReporter` already imported there):

```ts
test("--update bumps a version tag, keeps a branch pin, and rewrites only the entry line", async () => {
  const written: Record<string, string> = {};
  const exec: Exec = async (cmd, args) => {
    if (cmd === "git" && args[0] === "ls-remote") {
      return { code: 0, stdout: "abc\trefs/tags/v6.3.0\ndef\trefs/tags/v6.4.0\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const text = [
    "# obra/superpowers@v6.3.0 was chosen because it is stable",
    "obra/superpowers@v6.3.0   # keep this comment",
    "ayghri/i-have-adhd@main",
    "",
  ].join("\n");
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "company/skills.list", text }],
    exec,
    reporter: r,
    skillsBin: "/fake/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
    update: true,
    writeList: (path, next) => {
      written[path] = next;
    },
  });
  expect(code).toBe(0);
  expect(written["company/skills.list"]).toBe(
    [
      "# obra/superpowers@v6.3.0 was chosen because it is stable",
      "obra/superpowers@v6.4.0   # keep this comment",
      "ayghri/i-have-adhd@main",
      "",
    ].join("\n"),
  );
  expect(r.counts().updated).toBe(1);
  expect(r.counts().skipped).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/lists.test.ts packages/cli/src/commands/install-skills.test.ts`
Expected: FAIL — `replaceListLine is not exported`, and the `--update` test writes the comment line.

- [ ] **Step 3: Implement**

In `lists.ts`, add:

```ts
// A pin that names a release: "v1.2.3" or "1.2". A branch or a commit never matches.
export const VERSION_TAG = /^v?\d+(\.\d+)*$/;

// Rewrites the one list line whose entry text equals `raw`, and keeps everything else on that
// line: indentation and a trailing comment. A comment that mentions the same text, and any
// second identical line, stay untouched.
export function replaceListLine(text: string, raw: string, next: string): string {
  let done = false;
  return text
    .split("\n")
    .map((line) => {
      if (done) return line;
      const hash = line.indexOf("#");
      const code = hash === -1 ? line : line.slice(0, hash);
      if (code.trim() !== raw) return line;
      done = true;
      const start = code.indexOf(raw);
      return `${line.slice(0, start)}${next}${line.slice(start + raw.length)}`;
    })
    .join("\n");
}
```

In `install-skills.ts`: import `replaceListLine` and `VERSION_TAG` from `../lists`; in `highestTag` replace the inline `/^v?\d+(\.\d+)*$/` with `VERSION_TAG`; rewrite the `--update` loop body:

```ts
for (const entry of l.entries.filter((e) => e.ref !== undefined)) {
  if (!VERSION_TAG.test(entry.ref ?? "")) {
    reporter.item(entry.repo, "skipped", `pin "${entry.ref}" is a branch or a commit, not a version tag — kept`);
    continue;
  }
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
  text = replaceListLine(text, entry.raw, next);
  reporter.item(entry.repo, "updated", `pin ${entry.ref} -> ${tag}`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/lists.test.ts packages/cli/src/commands/install-skills.test.ts && bun run check && bun run typecheck`
Expected: PASS, no new lint warnings.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lists.ts packages/cli/src/lists.test.ts packages/cli/src/commands/install-skills.ts packages/cli/src/commands/install-skills.test.ts
git commit -m "Rewrite one list line on --update and keep a branch pin

A first-occurrence substring replace rewrote a comment that named the
entry, or a duplicate line. --update also bumped a deliberate branch pin
to a version tag. Both lists share one line rewriter now, and --update
bumps version tags only.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A2: Reject a short commit hash as a skills pin

**Files:**
- Modify: `packages/cli/src/commands/install-skills.ts:40`
- Test: `packages/cli/src/commands/install-skills.test.ts`

**Why:** `isSha` matches 40 hex characters only. A short hash such as `1a2b3c4` passes to the skills CLI, which cannot check out a commit.

- [ ] **Step 1: Write the failing test**

```ts
test("rejects a short commit hash as a pin before it reaches the skills CLI", async () => {
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "l", text: "acme/skills@1a2b3c4\n" }],
    exec: fakeExec(calls),
    reporter: r,
    skillsBin: "/fake/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
  expect(calls.some((c) => c.includes("add"))).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/commands/install-skills.test.ts -t "short commit hash"`
Expected: FAIL — `add` was called, `failed` is 0.

- [ ] **Step 3: Implement**

```ts
// Seven to forty hex characters is a commit hash, short or full. The skills CLI checks out a tag
// or a branch only.
const isSha = (ref: string | undefined): boolean => ref !== undefined && /^[0-9a-f]{7,40}$/i.test(ref);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/commands/install-skills.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/install-skills.ts packages/cli/src/commands/install-skills.test.ts
git commit -m "Reject a short commit hash as a skills pin

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A3: `update` prints the summary when `yarn install` fails

**Files:**
- Modify: `packages/cli/src/commands/update.ts:48-52`
- Test: `packages/cli/src/commands/update.test.ts`

**Why:** The `git pull` failure path prints `reporter.summary()`; the `yarn install` failure path returns 1 without it. Read `update.test.ts` first: it already fakes a pin move (around line 77) and a fake `exec`. Copy that fixture.

- [ ] **Step 1: Write the failing test**

Model on the existing pin-move test. The fake `exec` returns `{ code: 1, stdout: "", stderr: "error Couldn't find package" }` for `yarn install`. Collect every `write` line.

```ts
test("a failing yarn install prints the summary before it exits 1", async () => {
  // Copy the pin-move fixture of the existing test above, then:
  const lines: string[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === "yarn" && args[0] === "install") return { code: 1, stdout: "", stderr: "error Couldn't find package" };
    return fixtureExec(cmd, args, opts); // the fixture's exec, which fakes git pull and the pin move
  };
  const r = createReporter((l) => lines.push(l), false);
  const code = await runUpdate({ ...fixtureDeps, exec, reporter: r, write: (l) => lines.push(l) });
  expect(code).toBe(1);
  expect(lines.some((l) => l.includes("failed 1"))).toBe(true);
});
```

Adapt `fixtureExec` and `fixtureDeps` to the names the existing test uses.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/commands/update.test.ts -t "failing yarn install"`
Expected: FAIL — no line contains `failed 1`.

- [ ] **Step 3: Implement**

```ts
if (install.code !== 0) {
  reporter.item("yarn install", "failed", install.stderr.split("\n")[0] ?? "");
  write(reporter.summary());
  return 1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/commands/update.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/update.ts packages/cli/src/commands/update.test.ts
git commit -m "Print the update summary when yarn install fails

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A4: A missing skills CLI or a missing yarn warns and continues

**Files:**
- Modify: `packages/cli/src/commands/install-skills.ts:13-19, 58-69, 105-117`
- Modify: `packages/cli/src/index.ts:109, 133`
- Modify: `packages/cli/src/commands/update.ts:46-56`
- Test: `packages/cli/src/commands/install-skills.test.ts`, `packages/cli/src/commands/update.test.ts`

**Why:** Spec, "Skills Installer": "When a dependency (npm, skills) is absent, the script warns and continues." Today `resolveSkillsBin()` throws from `index.ts:109` before `git pull` runs, and a missing `yarn` reports a failure and aborts the installers.

**Interfaces:**
- Produces: `resolveSkillsBin(): string | undefined`; `runInstallSkills` deps `skillsBin: string | undefined`; `runUpdate` deps `skillsBin: string | undefined`.

- [ ] **Step 1: Write the failing tests**

`install-skills.test.ts`:

```ts
test("a missing skills CLI is skipped with a remedy and fails nothing", async () => {
  const calls: string[][] = [];
  const r = createReporter(() => {}, false);
  const code = await runInstallSkills({
    lists: [{ path: "l", text: "obra/superpowers@v6.3.0\n" }],
    exec: fakeExec(calls),
    reporter: r,
    skillsBin: undefined,
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  });
  expect(code).toBe(0);
  expect(calls).toEqual([]);
  expect(r.counts().skipped).toBe(1);
  expect(r.counts().failed).toBe(0);
});
```

`update.test.ts` (reuse the pin-move fixture from Task A3):

```ts
test("a missing yarn keeps the current CLI, warns, and still runs the installers", async () => {
  const lines: string[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === "yarn") return { code: 127, stdout: "", stderr: "" }; // realExec maps ENOENT to 127
    return fixtureExec(cmd, args, opts);
  };
  const r = createReporter((l) => lines.push(l), false);
  const code = await runUpdate({ ...fixtureDeps, exec, reporter: r, write: (l) => lines.push(l) });
  expect(lines.some((l) => l.includes("yarn is not installed"))).toBe(true);
  expect(lines.some((l) => l.includes("== Base template sync =="))).toBe(true);
  expect(r.counts().failed).toBe(0);
  expect(code).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/commands/install-skills.test.ts packages/cli/src/commands/update.test.ts`
Expected: FAIL — type error on `skillsBin: undefined`; the update test sees `failed 1` and no installer section.

- [ ] **Step 3: Implement**

`install-skills.ts`:

```ts
// The skills CLI is a dependency of this package, so a normal install always has it. A missing
// module means a broken or partial install. The installer then skips with a remedy (spec: warn
// and continue). It never aborts the whole update before git pull.
export function resolveSkillsBin(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("skills/package.json");
    const pkg: { bin: string | Record<string, string> } = require("skills/package.json");
    const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.skills ?? Object.values(pkg.bin)[0] ?? "");
    return join(dirname(pkgPath), rel);
  } catch {
    return undefined;
  }
}
```

Change the deps type to `skillsBin: string | undefined;`. After the `agents.length === 0` check and before the Node floor check, add:

```ts
if (deps.skillsBin === undefined) {
  reporter.item(
    "skills",
    "skipped",
    'the skills CLI is not installed — run "yarn install" in the company repository, then run wagglebot update again',
  );
  return 0;
}
```

Then use `const skillsBin = deps.skillsBin;` in the two `exec(process.execPath, [skillsBin, ...])` calls (after the check TypeScript narrows it).

`update.ts` — replace lines 46–56:

```ts
if (company.pin !== pinBefore && deps.skipSelfUpdate !== true) {
  write(`wagglebot pin moved ${pinBefore} -> ${company.pin}; running yarn install`);
  const install = await exec("yarn", ["install"], { cwd: root });
  if (install.code === 127) {
    // realExec maps a command that does not exist to 127. The installers below still run, with
    // the CLI that is installed now (spec: a missing dependency warns and continues).
    reporter.item(
      "yarn install",
      "skipped",
      `yarn is not installed. The pin moved to ${company.pin}, but this run keeps the current CLI. Install yarn, run "yarn install" in the company repository, then run wagglebot update again.`,
    );
  } else if (install.code !== 0) {
    reporter.item("yarn install", "failed", install.stderr.split("\n")[0] ?? "");
    write(reporter.summary());
    return 1;
  } else {
    const rerun = await exec("yarn", ["wagglebot", "update", "--skip-self-update"], { cwd: root });
    write(rerun.stdout);
    return rerun.code;
  }
}
```

Change the `runUpdate` deps type to `skillsBin: string | undefined;`. `index.ts` needs no change beyond compiling: `resolveSkillsBin()` no longer throws.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src && bun run check && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/install-skills.ts packages/cli/src/commands/install-skills.test.ts packages/cli/src/commands/update.ts packages/cli/src/commands/update.test.ts packages/cli/src/index.ts
git commit -m "Warn and continue when the skills CLI or yarn is missing

The spec says a missing dependency warns and continues. resolveSkillsBin
threw before git pull ran, and a missing yarn aborted every installer.
Both now report a skipped item with the remedy and let the run continue.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A5: Pin warnings are warnings, and the organization is declared

**Files:**
- Modify: `packages/cli/src/lists.ts`, `packages/cli/src/company.ts`, `packages/cli/src/commands/install-skills.ts:58-74`, `packages/cli/src/commands/install-agents.ts:30-45`, `packages/cli/src/index.ts:120-160`, `packages/cli/src/commands/update.ts:75-96`
- Test: `packages/cli/src/lists.test.ts`, `packages/cli/src/company.test.ts`, `packages/cli/src/commands/install-skills.test.ts`, `packages/cli/src/commands/install-agents.test.ts`

**Why:** D32: an entry outside the organization must pin; an entry inside may skip the pin. `lists.ts:25` warns for every unpinned entry, and `install-skills.ts:74` reports each warning as a `skipped` item, which inflates the counters. The reporter already has `warn()`, which is not counted. "Inside the organization" must be declared, never derived (P33): the company `package.json` carries `"wagglebot": { "organization": ["github.com/acme", "git.acme.local"] }`. Group D adds that key to the scaffold and documents it; this task reads it and defaults to `[]`.

**Interfaces:**
- Produces: `hostPath(entry: ListEntry): string`, `insideOrganization(entry: ListEntry, organization: string[]): boolean`, `parseList(text: string, options?: { organization?: string[] })` in `lists.ts`; `CompanyRepo.organization: string[]` in `company.ts`; `organization?: string[]` in the deps of `runInstallSkills` and `runInstallAgents`.

- [ ] **Step 1: Write the failing tests**

`lists.test.ts`:

```ts
import { hostPath, insideOrganization, parseList } from "./lists";

const one = (text: string) => {
  const entry = parseList(text).entries[0];
  if (entry === undefined) throw new Error("no entry");
  return entry;
};

test("hostPath normalizes shorthand, https, scp-like, and ssh URLs to host/path", () => {
  expect(hostPath(one("acme/tools"))).toBe("github.com/acme/tools");
  expect(hostPath(one("https://git.acme.local/platform/skills.git v1"))).toBe("git.acme.local/platform/skills");
  expect(hostPath(one("git@github.com:acme/tools.git"))).toBe("github.com/acme/tools");
  expect(hostPath(one("ssh://git@git.acme.local:2222/platform/skills.git"))).toBe("git.acme.local:2222/platform/skills");
});

test("insideOrganization matches a whole prefix segment only", () => {
  expect(insideOrganization(one("acme/tools"), ["github.com/acme"])).toBe(true);
  expect(insideOrganization(one("acme-labs/tools"), ["github.com/acme"])).toBe(false);
  expect(insideOrganization(one("https://git.acme.local/x/y.git"), ["git.acme.local"])).toBe(true);
  expect(insideOrganization(one("acme/tools"), [])).toBe(false);
});

test("an unpinned entry inside the organization produces no warning", () => {
  expect(parseList("acme/tools\n", { organization: ["github.com/acme"] }).warnings).toEqual([]);
  expect(parseList("acme/tools\n").warnings.length).toBe(1);
  expect(parseList("acme/tools\n").warnings[0]).toContain("wagglebot.organization");
});
```

`company.test.ts` (read the file first; it has a fixture that writes a company repo into a temp dir — extend it):

```ts
test("reads wagglebot.organization from package.json and defaults to an empty list", () => {
  // Build a fixture with "wagglebot": { "organization": ["github.com/acme"] } in package.json.
  expect(loadCompanyRepo(rootWithOrganization).organization).toEqual(["github.com/acme"]);
  expect(loadCompanyRepo(rootWithoutOrganization).organization).toEqual([]);
});

test("a malformed wagglebot.organization is a hard error that names the key", () => {
  // package.json with "wagglebot": { "organization": "github.com/acme" }
  expect(() => loadCompanyRepo(rootWithStringOrganization)).toThrow(/wagglebot\.organization/);
});
```

`install-skills.test.ts`:

```ts
test("an unpinned third-party entry is a warning line, not a counted item", async () => {
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  await runInstallSkills({
    lists: [{ path: "l", text: "acme/tools\n" }],
    exec: fakeExec([]),
    reporter: r,
    skillsBin: "/fake/skills",
    skillsAgents: ["claude-code"],
    managedFile: managed(),
    skillLockFile: NO_LOCK,
    nodeVersion: NODE,
  });
  expect(lines.some((l) => l.includes("warning") && l.includes("acme/tools"))).toBe(true);
  expect(r.counts().skipped).toBe(0);
});
```

`install-agents.test.ts`:

```ts
test("an unpinned third-party agents entry is a warning line", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [{ path: "agents.base.list", text: "acme/agents\n" }],
    agentDirs: [],
    exec: fakeGit,
    reporter: r,
  });
  expect(lines.some((l) => l.includes("warning") && l.includes("acme/agents"))).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/lists.test.ts packages/cli/src/company.test.ts packages/cli/src/commands`
Expected: FAIL — missing exports, `organization` undefined, skipped count 1, no warning line in install-agents.

- [ ] **Step 3: Implement**

`lists.ts`:

```ts
export type ListOptions = { organization?: string[] };

// The "host/path" of an entry: no scheme, no user, no ".git" suffix. A port stays part of the host.
// A prefix under "wagglebot.organization" in the company package.json matches against this string.
export function hostPath(entry: ListEntry): string {
  if (entry.isUrl !== true) return `github.com/${entry.repo}`;
  const url = entry.repo.replace(/\.git$/, "");
  const scheme = /^[a-z][\w+.-]*:\/\//i.exec(url);
  // scp-like "[user@]host:path" has no scheme.
  if (scheme === null) return url.replace(/^[^@]+@/, "").replace(":", "/");
  return url.slice(scheme[0].length).replace(/^[^@/]+@/, "");
}

// A prefix matches whole segments: "github.com/acme" covers "github.com/acme/tools", never
// "github.com/acme-labs/tools".
export const insideOrganization = (entry: ListEntry, organization: string[]): boolean => {
  const hp = hostPath(entry);
  return organization.some((prefix) => hp === prefix || hp.startsWith(`${prefix}/`));
};
```

In `parseList(text: string, options: ListOptions = {})`, build each entry first, then:

```ts
if (entry.ref === undefined && !insideOrganization(entry, options.organization ?? [])) {
  warnings.push(
    `${entry.repo}: no pin. A repository outside your organization must pin a tag. Add "@<tag>" to the entry, or a space and the tag after a URL. If your organization owns the repository, list its host/path prefix under "wagglebot.organization" in package.json.`,
  );
}
```

Apply the check to URL entries too (today only shorthand entries warn).

`company.ts`: extend `pinOf` into `readPackage(root): { pin?: string; organization: string[] }`:

```ts
type CompanyPackage = { dependencies?: Record<string, string>; wagglebot?: { organization?: unknown } };

const readPackage = (root: string): { pin?: string; organization: string[] } => {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return { organization: [] };
  const pkg: CompanyPackage = JSON.parse(readFileSync(pkgPath, "utf8"));
  const raw = pkg.wagglebot?.organization;
  if (raw !== undefined && !(Array.isArray(raw) && raw.every((p) => typeof p === "string"))) {
    throw new Error(`${pkgPath}: "wagglebot.organization" must be a list of "host/path" prefixes, for example ["github.com/acme"]`);
  }
  return { pin: pkg.dependencies?.wagglebot, organization: raw ?? [] };
};
```

Keep `pinOf(root)` as `readPackage(root).pin` so `findCompanyRoot` is unchanged. Add `organization: string[]` to `CompanyRepo` and set it in `loadCompanyRepo`.

`install-skills.ts`: add `organization?: string[]` to deps; `parseList(l.text, { organization: deps.organization })`; line 74 becomes `for (const l of parsed) for (const w of l.warnings) reporter.warn(`${l.path}: ${w}`);`. The `repoOf` helper keeps calling `parseList(raw)` with no options.

`install-agents.ts`: add `organization?: string[]` to deps; replace line 45 with:

```ts
const parsed = deps.listTexts.map((l) => ({ ...l, ...parseList(l.text, { organization: deps.organization }) }));
for (const l of parsed) for (const w of l.warnings) reporter.warn(`${l.path}: ${w}`);
const entries = parsed.flatMap((l) => l.entries);
```

`index.ts` and `update.ts`: pass `organization: company.organization` to both `runInstallSkills` and `runInstallAgents`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src && bun run check && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lists.ts packages/cli/src/lists.test.ts packages/cli/src/company.ts packages/cli/src/company.test.ts packages/cli/src/commands/install-skills.ts packages/cli/src/commands/install-skills.test.ts packages/cli/src/commands/install-agents.ts packages/cli/src/commands/install-agents.test.ts packages/cli/src/index.ts packages/cli/src/commands/update.ts
git commit -m "Warn on unpinned third-party entries only, and declare the organization

D32: an entry outside the organization must pin, an entry inside may
skip the pin. The company package.json declares the organization as
host/path prefixes under wagglebot.organization (P33: declared, never
derived). A pin warning is a warning line now, not a skipped item.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Group B — sync-agents, hooks merge, install-agents files, backups

### Task B1: A corrupt hook fragment fails one item, not the run

**Files:**
- Modify: `packages/cli/src/commands/sync-agents.ts:17-24, 78-83`
- Test: `packages/cli/src/commands/sync-agents.test.ts`

**Why:** Lines 80–81 read and parse the shipped fragment outside `writeTarget`'s try/catch. A bad fragment throws out of the command. `sync-agents.test.ts:60` covers a corrupt target only.

**Interfaces:**
- Produces: optional dep `fragmentsDir?: string` on `runSyncAgents` (default `join(templatesDir(), "hooks")`).

- [ ] **Step 1: Write the failing test**

```ts
test("a corrupt hook fragment fails the hooks item only, and the template targets still sync", () => {
  const { home, instructionsDir } = setup();
  const fragmentsDir = mkdtempSync(join(tmpdir(), "wgl-frag-"));
  writeFileSync(join(fragmentsDir, "claude-code.json"), "{ not json");
  const r = createReporter(() => {}, false);
  const code = runSyncAgents({ home, harnesses: HARNESSES, instructionDirs: [instructionsDir], reporter: r, fragmentsDir });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
  expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/commands/sync-agents.test.ts -t "corrupt hook fragment"`
Expected: FAIL — type error on `fragmentsDir`, then a thrown `SyntaxError`.

- [ ] **Step 3: Implement**

Add `fragmentsDir?: string;` to deps. Replace lines 78–83:

```ts
const fragmentsDir = deps.fragmentsDir ?? join(templatesDir(), "hooks");
const readFragment = (file: string): { hooks: Record<string, unknown[]> } =>
  JSON.parse(readFileSync(join(fragmentsDir, file), "utf8"));
// ...
const hooksTarget = harness.hooksTarget;
if (hooksTarget !== undefined) {
  // The fragment is read inside the try of writeTarget: a bad fragment fails this item only.
  writeTarget(hooksTarget.path, (existing) => mergeHooks(existing, readFragment(hooksTarget.fragmentFile)));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/commands/sync-agents.test.ts && bun run check && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/sync-agents.ts packages/cli/src/commands/sync-agents.test.ts
git commit -m "Fail one item, not the run, on a corrupt hook fragment

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task B2: `chmod 600` the hooks settings file

**Files:**
- Modify: `packages/cli/src/commands/sync-agents.ts` (the `writeTarget` call for hooks)
- Test: `packages/cli/src/commands/sync-agents.test.ts`

**Why:** Spec "Distribution": "Apply `chmod 600`." Template targets get it; the hooks JSON target does not.

- [ ] **Step 1: Write the failing test**

Add to the first test in the file (`writes every template target inside a managed block, chmod 600`):

```ts
expect(statSync(join(home, ".claude/settings.json")).mode & 0o777).toBe(0o600);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/commands/sync-agents.test.ts -t "chmod 600"`
Expected: FAIL — mode is `0o644`.

- [ ] **Step 3: Implement**

Pass `0o600` as the third argument of the hooks `writeTarget` call.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/commands/sync-agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/sync-agents.ts packages/cli/src/commands/sync-agents.test.ts
git commit -m "Apply chmod 600 to the hooks settings file

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task B3: `mergeHooks` keeps every entry in place

**Files:**
- Modify: `packages/cli/src/managed-json.ts:44-58`
- Test: `packages/cli/src/managed-json.test.ts`

**Why:** `hooks[event] = [...foreign, ...fragmentEntries]` moves every wagglebot entry to the end, so a hand-ordered user array is reshuffled once.

- [ ] **Step 1: Write the failing tests**

```ts
test("mergeHooks replaces an owned entry where it stands and keeps foreign entries in place", () => {
  const owned = { hooks: [{ type: "command", command: "echo wagglebot:old" }] };
  const fresh = { hooks: [{ type: "command", command: "echo wagglebot:new" }] };
  const existing = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "a" }, owned, { matcher: "b" }] } });
  const { next } = mergeHooks(existing, { hooks: { PreToolUse: [fresh] } });
  expect(JSON.parse(next).hooks.PreToolUse).toEqual([{ matcher: "a" }, fresh, { matcher: "b" }]);
});

test("mergeHooks appends a new owned entry and drops one the fragment no longer carries", () => {
  const one = { hooks: [{ command: "wagglebot:one" }] };
  const two = { hooks: [{ command: "wagglebot:two" }] };
  const shrunk = mergeHooks(JSON.stringify({ hooks: { E: [one, { matcher: "x" }, two] } }), { hooks: { E: [one] } });
  expect(JSON.parse(shrunk.next).hooks.E).toEqual([one, { matcher: "x" }]);
  const grown = mergeHooks(JSON.stringify({ hooks: { E: [{ matcher: "x" }] } }), { hooks: { E: [one, two] } });
  expect(JSON.parse(grown.next).hooks.E).toEqual([{ matcher: "x" }, one, two]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/managed-json.test.ts`
Expected: FAIL — the owned entry moves to the end.

- [ ] **Step 3: Implement**

```ts
// Merges hook fragment entries into a settings object. Owns only array elements whose command
// contains "wagglebot:". A foreign element keeps its position. An owned element is replaced in
// place by the next fragment entry; a fragment entry without a slot is appended; an owned
// element without a fragment entry left is stale and dropped (F22).
export function mergeHooks(
  existingText: string,
  fragment: { hooks: Record<string, unknown[]> },
): { next: string; changed: boolean } {
  const doc = parseObject(existingText);
  const hooks = isObject(doc.hooks) ? { ...(doc.hooks as JsonObject) } : {};
  for (const [event, fragmentEntries] of Object.entries(fragment.hooks)) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const pending = [...fragmentEntries];
    const merged: unknown[] = [];
    for (const element of current) {
      if (!carriesMarker(element)) {
        merged.push(element);
        continue;
      }
      const replacement = pending.shift();
      if (replacement !== undefined) merged.push(replacement);
    }
    merged.push(...pending);
    hooks[event] = merged;
  }
  doc.hooks = hooks;
  const next = print(doc);
  return { next, changed: next !== normalized(existingText) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/managed-json.test.ts packages/cli/src/commands/sync-agents.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/managed-json.ts packages/cli/src/managed-json.test.ts
git commit -m "Keep hook entries in place when the fragment merges

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task B4: A cloned repository's README is not a subagent

**Files:**
- Modify: `packages/cli/src/commands/install-agents.ts:93, 107-110`
- Test: `packages/cli/src/commands/install-agents.test.ts`

**Why:** Line 93 installs every top-level `.md` of a cloned list repository, `README.md` included. The `readme.md` filter at line 109 applies to `company/` and `teams/` agent directories only.

- [ ] **Step 1: Write the failing test**

```ts
test("a README.md in a cloned repository is not installed as a subagent", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const git: Exec = async (cmd, args) => {
    if (cmd === "git" && args[0] === "clone") {
      const dir = args.at(-1) ?? "";
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "README.md"), "# About\n");
      writeFileSync(join(dir, "reviewer.md"), "# Reviewer agent\n");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [{ path: "l", text: "acme/agents@v1\n" }],
    agentDirs: [],
    exec: git,
    reporter: quiet(),
  });
  expect(existsSync(join(home, ".claude/agents/acme__agents__README.md"))).toBe(false);
  expect(existsSync(join(home, ".claude/agents/acme__agents__reviewer.md"))).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/commands/install-agents.test.ts -t "README.md in a cloned"`
Expected: FAIL — `acme__agents__README.md` exists.

- [ ] **Step 3: Implement**

Add one helper above `runInstallAgents` and use it at both sites:

```ts
// The Markdown subagents of one directory, sorted. A README documents the directory; it is not an agent.
const subagentFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => f.toLowerCase() !== "readme.md")
    .sort();
```

Line 93: `const files = subagentFiles(cacheDir);`. Lines 107–110: `const files = subagentFiles(agentsDir);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/commands/install-agents.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/install-agents.ts packages/cli/src/commands/install-agents.test.ts
git commit -m "Skip the README of a cloned agent repository

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task B5: Back up a subagent file before it is overwritten

**Files:**
- Modify: `packages/cli/src/commands/install-agents.ts:55-64`
- Test: `packages/cli/src/commands/install-agents.test.ts`

**Why:** Spec "Distribution" rule 3: back up each target before the first mutation. `installFile` overwrites an existing subagent file without a backup; only the stale sweep backs up.

- [ ] **Step 1: Write the failing test**

```ts
import { startBackupSet } from "../backup";

test("an existing subagent file is backed up before it is overwritten", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const dest = join(home, ".claude/agents/acme__agents__reviewer.md");
  mkdirSync(join(home, ".claude/agents"), { recursive: true });
  writeFileSync(dest, "# Old\n");
  const backups = startBackupSet(join(home, ".wagglebot/backups"));
  await runInstallAgents({
    home,
    harnesses: HARNESSES,
    listTexts: [{ path: "l", text: "acme/agents@v1\n" }],
    agentDirs: [],
    exec: fakeGit,
    reporter: quiet(),
    backups,
  });
  expect(readFileSync(dest, "utf8")).toBe("# Reviewer agent\n");
  expect(readFileSync(join(backups.dir, dest.replaceAll("/", "%2F")), "utf8")).toBe("# Old\n");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/commands/install-agents.test.ts -t "backed up before"`
Expected: FAIL — ENOENT on the backup file.

- [ ] **Step 3: Implement**

```ts
const installFile = (dest: string, content: string): void => {
  produced.push(dest);
  const fresh = !existsSync(dest);
  if (!fresh && readFileSync(dest, "utf8") === content) {
    reporter.item(dest, "ok", "already ok");
    return;
  }
  if (!fresh) backups.backup(dest);
  writeFileSync(dest, content);
  reporter.item(dest, fresh ? "installed" : "updated");
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/commands/install-agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/install-agents.ts packages/cli/src/commands/install-agents.test.ts
git commit -m "Back up a subagent file before it is overwritten

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task B6: A backup set is unique per run, and a restore failure is reported

**Files:**
- Modify: `packages/cli/src/backup.ts`, `packages/cli/src/commands/sync-agents.ts:30-38`
- Test: `packages/cli/src/backup.test.ts`, `packages/cli/src/commands/sync-agents.test.ts`

**Why:** The set name has second granularity, so two manual commands inside one second share one directory and the second overwrites the backup of the first with an already-mutated file. `restoreSet` lets a `copyFileSync` error escape to the top-level catch.

**Interfaces:**
- Produces: `restoreSet(setDir: string, onlyTarget?: string): { restored: string[]; failed: { target: string; error: string }[] }`.

- [ ] **Step 1: Write the failing tests**

`backup.test.ts` — update the two existing assertions to the new shape, then add:

```ts
// existing test: replace
//   expect(restored).toEqual([target]);         -> expect(restored.restored).toEqual([target]);
//   expect(restoreSet(set.dir)).toEqual([]);    -> expect(restoreSet(set.dir).restored).toEqual([]);

test("two sets started inside one second get different directories", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-"));
  const a = startBackupSet(join(root, "backups"), new Date("2026-08-31T10:00:00.100Z"));
  const b = startBackupSet(join(root, "backups"), new Date("2026-08-31T10:00:00.900Z"));
  expect(a.dir).not.toBe(b.dir);
  expect(a.dir < b.dir).toBe(true); // newestBackupSet sorts by name
});

test("restoreSet reports a target it cannot write instead of throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-"));
  mkdirSync(join(root, "gone"));
  const target = join(root, "gone", "CLAUDE.md");
  writeFileSync(target, "original");
  const set = startBackupSet(join(root, "backups"));
  set.backup(target);
  rmSync(join(root, "gone"), { recursive: true });
  const result = restoreSet(set.dir);
  expect(result.restored).toEqual([]);
  expect(result.failed.map((f) => f.target)).toEqual([target]);
});
```

`sync-agents.test.ts` — the existing `--restore` test keeps passing; add:

```ts
test("--restore reports a file it cannot restore as failed and exits 1", () => {
  const { home, instructionsDir } = setup();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/CLAUDE.md"), "# Mine\n");
  runSyncAgents({ home, harnesses: HARNESSES, instructionDirs: [instructionsDir], reporter: quiet() });
  rmSync(join(home, ".claude"), { recursive: true }); // the restore target directory is gone
  const r = createReporter(() => {}, false);
  const code = runSyncAgents({ home, harnesses: [], instructionDirs: [], reporter: r, options: { restore: true } });
  expect(code).toBe(1);
  expect(r.counts().failed).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/backup.test.ts packages/cli/src/commands/sync-agents.test.ts`
Expected: FAIL — same dir for both sets; thrown ENOENT.

- [ ] **Step 3: Implement**

`backup.ts`:

```ts
// Millisecond precision: two commands inside one second must not share one set, because the
// second would overwrite the backup of the first with an already-mutated file.
// "20260831-100000100" — fixed width, so a name sort is a time sort.
const stamp = (d: Date): string => d.toISOString().replaceAll(/[-:.]/g, "").replace("T", "-").slice(0, 18);

export type RestoreResult = { restored: string[]; failed: { target: string; error: string }[] };

export function restoreSet(setDir: string, onlyTarget?: string): RestoreResult {
  const result: RestoreResult = { restored: [], failed: [] };
  if (!existsSync(setDir)) return result;
  for (const target of readdirSync(setDir).map(decode)) {
    if (onlyTarget !== undefined && target !== onlyTarget) continue;
    try {
      copyFileSync(join(setDir, encode(target)), target);
      result.restored.push(target);
    } catch (error) {
      result.failed.push({ target, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
```

`sync-agents.ts:36-37`:

```ts
const result = restoreSet(set, options.restoreTarget);
for (const target of result.restored) reporter.item(target, "updated", "restored");
for (const f of result.failed) reporter.item(f.target, "failed", f.error);
return result.failed.length > 0 ? 1 : 0;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src && bun run check && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit (two commits)**

```bash
git add packages/cli/src/backup.ts packages/cli/src/backup.test.ts
git commit -m "Name backup sets to the millisecond

Two commands inside one second shared one set, and the second run
overwrote the backup of the first with an already-mutated file.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then stage the `restoreSet` change together with the caller (split with `git add -p` if both changes landed in one edit of `backup.ts`; if that is impractical, make the millisecond change first, commit, then the restore change):

```bash
git add packages/cli/src/backup.ts packages/cli/src/backup.test.ts packages/cli/src/commands/sync-agents.ts packages/cli/src/commands/sync-agents.test.ts
git commit -m "Report a file that --restore cannot write instead of crashing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Group C — MCP writer, registry validation, MCP adapters

### Task C1: Report a file credential source once

**Files:**
- Modify: `packages/cli/src/commands/write-mcp.ts:79-88`
- Test: `packages/cli/src/commands/write-mcp.test.ts`

**Why:** The "file credential source arrives with the Phase 2 hub" skip is computed and reported inside the per-harness loop. With N MCP-capable harnesses it prints N times.

- [ ] **Step 1: Write the failing test**

```ts
test("a file credential source is reported once, not once per harness", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const claude = HARNESSES.find((h) => h.name === "claude-code");
  if (claude?.mcpTarget === undefined) throw new Error("fixture");
  const twice: Harness[] = [claude, { ...claude, name: "second", mcpTarget: { ...claude.mcpTarget, path: ".second.json" } }];
  const fileSourced: ProxyConfig = {
    namespace: "vault",
    mode: "remote_http",
    endpoint: "https://v/mcp",
    auth: { scheme: { kind: "bearer" }, source: { from: "file", path: "/x" } },
  };
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  runWriteMcp({ home, harnesses: twice, proxies: [fileSourced], env: {}, reporter: r });
  expect(lines.filter((l) => l.includes("vault")).length).toBe(1);
});
```

Import `type Harness` from `../harness`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/commands/write-mcp.test.ts -t "reported once"`
Expected: FAIL — two lines contain `vault`.

- [ ] **Step 3: Implement**

Move the `usable` computation and the skip report above the `for (const harness ...)` loop:

```ts
// A file credential source needs the Phase 2 hub. Report it once, then leave it out of every config.
const usable = proxies.filter((p) => !(p.auth !== undefined && p.auth.source.from === "file"));
for (const p of proxies.filter((x) => !usable.includes(x))) {
  reporter.item(p.namespace, "skipped", "file credential source arrives with the Phase 2 hub");
}
```

Delete the two lines inside the loop.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/commands/write-mcp.test.ts && bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/write-mcp.ts packages/cli/src/commands/write-mcp.test.ts
git commit -m "Report a file credential source once, not once per harness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C2: The registry loader validates every field and rejects an unknown key

**Files:**
- Modify: `packages/cli/src/registry.ts:23-100`
- Test: `packages/cli/src/registry.test.ts`

**Why:** `return rawProxies as ProxyConfig[]` is an unchecked cast. `args` element types, `endpoint`/`command` types, scheme sub-fields, and unknown keys (a typo such as `enpoint`) pass silently. P35: never pick a winner silently.

- [ ] **Step 1: Write the failing tests**

```ts
test("an unknown key is a hard error that names the key", () => {
  const text = "proxies:\n  - namespace: a\n    mode: remote_http\n    enpoint: https://x/mcp\n";
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/unknown key "enpoint"/);
});

test("args must be a list of strings", () => {
  const text = "proxies:\n  - namespace: a\n    mode: stdio_cmd\n    command: run\n    args: --flag\n";
  expect(() => loadRegistry(text, "r.yaml")).toThrow(/args must be a list of strings/);
});

test("a proxy that is not a mapping is a hard error", () => {
  expect(() => loadRegistry("proxies:\n  - just-a-string\n", "r.yaml")).toThrow(/must be a mapping/);
});

test("a header scheme needs a name and an env scheme needs a map of strings", () => {
  const header = "proxies:\n  - namespace: a\n    mode: remote_http\n    endpoint: https://x/mcp\n    auth: { scheme: { kind: header }, source: { from: env, var: T } }\n";
  expect(() => loadRegistry(header, "r.yaml")).toThrow(/scheme\.name/);
  const env = "proxies:\n  - namespace: a\n    mode: stdio_cmd\n    command: run\n    auth: { scheme: { kind: env, map: [X] }, source: { from: env, var: T } }\n";
  expect(() => loadRegistry(env, "r.yaml")).toThrow(/scheme\.map/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/registry.test.ts`
Expected: FAIL — no error thrown for the first three; the fourth passes or throws a different message.

- [ ] **Step 3: Implement**

Replace `RawProxy` and the loop with explicit narrowing. Keep every existing check and message. Sketch:

```ts
const KNOWN_KEYS = ["namespace", "mode", "endpoint", "command", "args", "env", "auth"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function loadRegistry(text: string, fileName: string): ProxyConfig[] {
  const doc: unknown = parse(text);
  const rawProxies: unknown[] = isRecord(doc) && Array.isArray(doc.proxies) ? doc.proxies : [];
  const seen = new Set<string>();
  const out: ProxyConfig[] = [];
  for (const item of rawProxies) {
    if (!isRecord(item)) fail(fileName, "", "each proxy must be a mapping with namespace and mode");
    const ns = typeof item.namespace === "string" ? item.namespace : "";
    if (ns === "" || /\s/.test(ns)) fail(fileName, ns, "namespace must be non-empty without whitespace");
    if (seen.has(ns)) fail(fileName, ns, "duplicate namespace");
    seen.add(ns);
    for (const key of Object.keys(item)) {
      if (!KNOWN_KEYS.includes(key)) fail(fileName, ns, `unknown key "${key}" — allowed keys: ${KNOWN_KEYS.join(", ")}`);
    }
    const mode = typeof item.mode === "string" ? item.mode : "";
    if (!MODES.has(mode)) fail(fileName, ns, `unknown mode "${mode}"`);
    if (item.endpoint !== undefined && typeof item.endpoint !== "string") fail(fileName, ns, "endpoint must be a string");
    if (item.command !== undefined && typeof item.command !== "string") fail(fileName, ns, "command must be a string");
    if (item.args !== undefined && !isStringList(item.args)) fail(fileName, ns, "args must be a list of strings");
    if (item.env !== undefined && !isRecord(item.env)) fail(fileName, ns, "env must be a mapping of ${VAR} expansions");
    // ... the existing endpoint / stdio_npx / stdio_cmd / env-expansion / auth checks, unchanged in wording ...
    // Additional scheme checks:
    //   kind "header": scheme.name must be a non-empty string; scheme.prefix, when present, a string.
    //   kind "basic":  scheme.username must be a non-empty string.
    //   kind "env":    scheme.map must be a mapping of strings.
    //   source "env":  source.var must be a non-empty string.
    //   source "file": source.path must be a non-empty string.
    out.push({
      namespace: ns,
      mode: mode as ProxyConfig["mode"], // narrowed by MODES.has above
      ...(typeof item.endpoint === "string" ? { endpoint: item.endpoint } : {}),
      ...(typeof item.command === "string" ? { command: item.command } : {}),
      ...(isStringList(item.args) ? { args: item.args } : {}),
      ...(isRecord(item.env) ? { env: item.env as Record<string, string> } : {}), // values validated above
      ...(item.auth !== undefined ? { auth: item.auth as ProxyConfig["auth"] } : {}), // shape validated above
    });
  }
  return out;
}
```

The two remaining `as` casts are on values the loop validated field by field on the lines above; leave a comment on each. Error messages for the new scheme checks: `auth.scheme.name is required for kind "header"`, `auth.scheme.username is required for kind "basic"`, `auth.scheme.map must be a mapping of strings for kind "env"`, `auth.source.var is required for from "env"`, `auth.source.path is required for from "file"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src && bun run check && bun run typecheck`
Expected: PASS (the write-mcp and update tests load registries too).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/registry.ts packages/cli/src/registry.test.ts
git commit -m "Validate every registry field and reject an unknown key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C3: MCP config adapters for Codex, Gemini, Copilot, Cline, and Junie

**Files:**
- Create: `packages/cli/src/mcp-dialects.ts`, `packages/cli/src/mcp-dialects.test.ts`, `docs/harnesses.md`
- Modify: `packages/cli/src/harness.ts` (the `mcpTarget` type and the six entries), `packages/cli/src/commands/write-mcp.ts`, `packages/cli/src/help.ts:12-15`, `README.md` (the "Documentation" table and the MCP line in "What You Get"), `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md` (one sentence after the "Distribution" target table that points at `docs/harnesses.md`)
- Test: `packages/cli/src/commands/write-mcp.test.ts`, `packages/cli/src/harness.test.ts`, `packages/cli/src/help.test.ts`

**Why:** Spec "The Update Command": the MCP config writer "writes the result into each harness MCP config". Only Claude Code has an adapter. The other five print `skipped … no MCP config adapter`.

**Vendor facts (verified 2026-09-09 against vendor documentation and source; the URLs go into `docs/harnesses.md` and into a comment on each `harness.ts` entry):**

| Harness | Global path | Format | Parent key / table | stdio fields | Streamable HTTP fields | SSE fields | `${VAR}` expansion | Credential mechanism wagglebot uses |
|---|---|---|---|---|---|---|---|---|
| claude-code | `~/.claude.json` | JSON | `mcpServers` | `command`, `args`, `env` | `type: "http"`, `url`, `headers` | `type: "sse"`, `url`, `headers` | Yes, `${VAR}` | `${VAR}` in `headers` and `env` |
| codex | `~/.codex/config.toml` | TOML | `[mcp_servers.<id>]` | `command`, `args`, `env_vars` (names to forward), `env` (literal sub-table, never written), `cwd` | `url`, `bearer_token_env_var`, `env_http_headers` (header name → env var name), `http_headers` (static, never written) | Not documented — skipped | None documented | `bearer_token_env_var` for a bearer scheme; `env_http_headers` for a header scheme without prefix; `env_vars` for a stdio env var whose key equals the source var |
| gemini | `~/.gemini/settings.json` | JSON | `mcpServers` (top level) | `command`, `args`, `env`, `cwd` | `httpUrl`, `headers` | `url`, `headers` | Yes, `$VAR`, `${VAR}`, `${VAR:-default}` | `${VAR}` in `headers` and `env`. A server name with `_` is skipped: the policy engine mis-parses it |
| copilot | `~/.copilot/mcp-config.json` | JSON | `mcpServers` | `type: "local"`, `command`, `args`, `env`, `tools` | `type: "http"`, `url`, `headers`, `tools` | `type: "sse"`, `url`, `headers`, `tools` | None documented | None — an entry that needs a credential is skipped. `tools: ["*"]` is always written (vendor example) |
| cline | `~/.cline/data/settings/cline_mcp_settings.json` | JSON | `mcpServers` | `command`, `args`, `env`, `disabled`, `autoApprove`, `timeout` (seconds) | `type: "streamableHttp"`, `url`, `headers` | `type: "sse"`, `url`, `headers` | None documented | None — an entry that needs a credential is skipped. Do not write `~/.cline/mcp.json`: the docs name it, the code never reads it (cline/cline#11671) |
| junie | `~/.junie/mcp/mcp.json` | JSON | `mcpServers` | `command`, `args`, `env` | `url`, `headers` (no `type`) | Not documented — skipped | None documented | None — an entry that needs a credential is skipped |

Sources: Codex — `https://learn.chatgpt.com/docs/extend/mcp?surface=cli`, `https://learn.chatgpt.com/docs/config-file/config-reference`. Gemini — `https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md`, `https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md`. Copilot — `https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers`. Cline — `https://docs.cline.bot/getting-started/config`, `sdk/packages/shared/src/storage/paths.ts` (`resolveMcpSettingsPath`), `https://github.com/cline/cline/issues/11671`. Junie — `https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html` (page dated 2026-09-09).

**Three traps.** Codex is the only TOML target and spells the table `mcp_servers` with an underscore. Gemini splits the URL field by transport: `httpUrl` for streamable HTTP, `url` for SSE; every other harness uses `url`. Cline's public MCP docs point at `~/.cline/mcp.json`, which the code never reads; write the `data/settings/` path.

**Design:**

```ts
// harness.ts
export type McpDialect = "claude" | "codex" | "gemini" | "copilot" | "cline" | "junie";
export type McpTarget =
  // A JSON file. Ownership is per child key under parentKey, recorded in ~/.wagglebot/managed.json.
  | { format: "json"; path: string; parentKey: string; dialect: McpDialect }
  // A TOML file. Ownership is a "# wagglebot:begin/end" block that holds one [<table>.<namespace>] per server.
  | { format: "toml"; path: string; table: string; dialect: "codex" };
```

```ts
// mcp-dialects.ts
export type Rendered = { ok: true; entry: Record<string, unknown> } | { ok: false; reason: string };

// One entry for one harness dialect, or the reason this proxy cannot be expressed there without
// writing a literal credential. A skip is honest; a literal secret is never written (F23).
export function renderEntry(dialect: McpDialect, p: ProxyConfig): Rendered;

// The content of the managed block for a TOML target: one [<table>.<ns>] table per entry, keys
// sorted as the dialect emits them, entries in namespace order, separated by one blank line.
export function renderTomlTables(table: string, entries: { namespace: string; entry: Record<string, unknown> }[]): string;

// True when writing this proxy needs a ${VAR}: an env credential source, or any env value.
export function needsExpansion(p: ProxyConfig): boolean;

// Kept for the existing tests; equals renderEntry("claude", p).entry.
export function proxyToClaudeEntry(p: ProxyConfig): Record<string, unknown>;
```

`write-mcp.ts` imports `proxyToClaudeEntry` from `../mcp-dialects` and re-exports it, so `write-mcp.test.ts` keeps importing it from `./write-mcp`.

**Dialect rules** (`url` is `p.endpoint`; `headers` is today's `headersFor`; `env` is today's merged `{ ...p.env, ...authEnv }`; stdio `command`/`args` are today's npx and cmd forms):

- `claude`: http → `{ type: "http", url, headers? }`; sse → `{ type: "sse", url, headers? }`; stdio → `{ command, args, env? }`. Never skips.
- `gemini`: namespace contains `_` → skip `"Gemini CLI mis-parses a server name with an underscore — rename the registry entry"`. http → `{ httpUrl: url, headers? }`; sse → `{ url, headers? }`; stdio → `{ command, args, env? }`.
- `copilot`: `needsExpansion(p)` → skip `"GitHub Copilot CLI does not expand ${VAR} in mcp-config.json — the credential would land as a literal, so the entry is left out"`. http → `{ type: "http", url, tools: ["*"] }`; sse → `{ type: "sse", url, tools: ["*"] }`; stdio → `{ type: "local", command, args, tools: ["*"] }`.
- `cline`: `needsExpansion(p)` → skip `"Cline does not expand ${VAR} in cline_mcp_settings.json — the credential would land as a literal, so the entry is left out"`. http → `{ type: "streamableHttp", url }`; sse → `{ type: "sse", url }`; stdio → `{ command, args }`.
- `junie`: `needsExpansion(p)` → skip `"Junie does not expand ${VAR} in mcp.json — the credential would land as a literal, so the entry is left out"`. sse → skip `"Junie documents no SSE transport"`. http → `{ url }`; stdio → `{ command, args }`.
- `codex`: sse → skip `"Codex documents no SSE transport"`. http: `{ url }` plus, by auth scheme: `bearer` → `bearer_token_env_var: VAR`; `header` with no `prefix` (undefined or `""`) → `env_http_headers: { [name]: VAR }`; `header` with a prefix → skip `"Codex sets a header from an env var without a prefix — drop the prefix or use a bearer scheme"`; `basic` → skip `"Codex has no env-var mechanism for basic auth"`; `none` or no auth → `{ url }` only. stdio: `{ command, args }` plus `env_vars`: for every `[key, "${VAR}"]` in the merged env map, `key === VAR` → push `key`; otherwise skip `"Codex forwards an environment variable under its own name only (env_vars) — the registry names ${VAR} for ${key}; rename one so they match"`. `env_vars` is omitted when empty.

**TOML text** (`renderTomlTables("mcp_servers", …)`): a table header `[mcp_servers.<key>]` where `<key>` is the namespace bare when it matches `/^[A-Za-z0-9_-]+$/`, else quoted `"<ns>"` with `JSON.stringify`. Values: a string → `JSON.stringify(value)` (a TOML basic string accepts every escape `JSON.stringify` emits for these inputs); a string array → `[` + items joined by `, ` + `]`; a string-to-string record → `{ "K" = "V", … }` with keys quoted. Keys within a table in this order: `command`, `args`, `env_vars`, `url`, `bearer_token_env_var`, `env_http_headers`. Example output for the `remote` and `stdio_npx` fixtures of `write-mcp.test.ts`:

```toml
[mcp_servers.example]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "EXAMPLE_TOKEN"

[mcp_servers.gh]
command = "npx"
args = ["-y", "@example/mcp@1.4.2", "--flag"]
env_vars = ["GH_TOKEN"]
```

(The `gh` fixture maps `GH_TOKEN` from `MY_GH_TOKEN`; in the TOML test use a fixture whose map key equals its source var, `{ GH_TOKEN: "$SOURCE" }` with `var: "GH_TOKEN"`, and add a second test that the renamed fixture is skipped with the `env_vars` reason.)

**`write-mcp.ts` per harness:**
1. For each usable proxy call `renderEntry(target.dialect, p)`. A skip is reported once per (harness, namespace): `reporter.item(`${p.namespace} (${harness.name})`, "skipped", reason)`.
2. `format: "json"`: today's path with the rendered entries.
3. `format: "toml"`: read the file. For every rendered namespace, when the text **outside** the managed block matches `^\s*\[<table>\.(<key>)\]` for that namespace (bare or quoted key), report `failed` with `"already defined outside the wagglebot block in <path> — remove it there, or rename the registry entry"` and drop that entry. Then: no entries and no block → `skipped` `"no MCP servers in the registry — file not created"`; no entries and a block → `removeManagedBlock(existing, "hash")`; else `renderManagedBlock(existing, renderTomlTables(...), "hash")`. Unchanged → `ok`. Else back up, `mkdirSync` the parent, write, report `updated` with the entry count. No `chmod`: the file belongs to the harness, and the block carries no secret.
4. `help.ts` `mcpFiles()`: JSON → `~/<path>  (<name>, managed keys under <parentKey>)`; TOML → `~/<path>  (<name>, managed block, one [<table>.<namespace>] table per server)`.

**`docs/harnesses.md`** — a reference page with: a one-paragraph purpose ("what wagglebot writes where, and why some entries are skipped; edit this table and `harness.ts` together when a vendor changes"); the vendor table above verbatim plus a "Verified" column with the date; the three traps; a "Skipped entries" list that names each skip reason and the fix; a "TOML block" note (the block sits at the end of `config.toml`; a key that a person appends after the block lands in the last wagglebot table — put personal tables above the block); and "Add a harness": 1. Add the entry to `HARNESSES` in `packages/cli/src/harness.ts` with the source URL in a comment. 2. Add a dialect to `packages/cli/src/mcp-dialects.ts` when the fields differ from an existing one. 3. Add one test per mode in `mcp-dialects.test.ts`. 4. Add the row to this table. `README.md` "Documentation" table gets a row `| [Harness reference](docs/harnesses.md) | Every file wagglebot writes per harness, and the MCP config format of each. |`.

- [ ] **Step 1: Write the failing tests.** `mcp-dialects.test.ts`: for each of the six dialects, one test per mode (http, sse, stdio) with the `remote` and `stdio_npx` fixtures — assert the exact entry, or the exact skip reason; the codex header-with-prefix, basic, renamed-env, and sse skips; the gemini underscore skip; `renderTomlTables` produces the exact text above; `needsExpansion` is false for a proxy with no auth and no env, true with an env auth source, true with an env map. `write-mcp.test.ts`: a TOML target writes a hash block and preserves the text outside it; a second run is `ok`; a namespace already defined outside the block is `failed` and left out; an emptied registry removes the block; a JSON dialect without expansion skips the credentialed proxy and writes the credential-free one; the skip line appears once per harness. `harness.test.ts`: every `mcpTarget.path` is home-relative and contains no `~`; the six names each have an `mcpTarget`. `help.test.ts`: `helpText("write-mcp")` contains `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.copilot/mcp-config.json`, `~/.cline/data/settings/cline_mcp_settings.json`, `~/.junie/mcp/mcp.json`.
- [ ] **Step 2: Run** `bun test packages/cli/src` — FAIL on the new tests.
- [ ] **Step 3: Implement** `mcp-dialects.ts`, the `McpTarget` type and six `harness.ts` entries (a source URL comment on each), the `write-mcp.ts` JSON and TOML branches, `help.ts`.
- [ ] **Step 4: Run** `bun test && bun run check && bun run typecheck && bun run build && node packages/cli/bin/wagglebot.js write-mcp --help`. PASS; the help lists six files.
- [ ] **Step 5: Commit — one commit per harness**, in this order. First `Write MCP configs for Codex` (the dialect module, `Rendered`, the TOML renderer, the TOML branch in `write-mcp.ts`, the `McpTarget` type, the Codex entry, `help.ts`). Then `Write MCP configs for Gemini CLI`, `Write MCP configs for GitHub Copilot CLI`, `Write MCP configs for Cline`, `Write MCP configs for Junie` — each adds its dialect, its `harness.ts` entry, and its tests. Last, `Document every harness MCP config in docs/harnesses.md` adds the reference page, the README row, and the one-sentence pointer in the Phase 1 spec.

---

## Group D — Scaffold and first-party skills

### Task D1: The team layer scaffold carries the same six items as `company/`

**Files:**
- Create: `packages/cli/templates/init/teams/team-payments/registry.yaml`, `skills.list`, `agents.list`, `agents/README.md`, `instructions/00-example.md`
- Modify: `packages/cli/templates/init/teams/team-payments/README.md`
- Regenerate: `test-app/`

**Why:** Spec "Company Repository Layout": `teams/<team>/` carries "same six items". The scaffold ships `catalog.yaml` and `README.md` only. Empty directories do not survive git, so each directory gets a README or an example file.

- [ ] **Step 1: Run the scaffold drift test to see it pass** (baseline): `bun test packages/cli/e2e/scaffold.test.ts` — PASS.

- [ ] **Step 2: Create the files** with exactly this content.

`registry.yaml`:

```yaml
# MCP servers for the members of Group team-payments. This file never contains a secret.
# Same format as company/registry.yaml. A team entry with the same namespace as a company entry wins.
proxies: []
```

`skills.list`:

```
# Curated skill packages for the members of Group team-payments, one per line.
# Same format as company/skills.list: owner/repo@<tag>, or a full git URL, a space, and the ref.
# Pin every repository that the company does not control.
```

`agents.list`:

```
# Shared subagents from other repositories, for the members of Group team-payments.
# Same format as company/agents.list: owner/repo[@ref], or a full clone URL and an optional ref.
# A subagent that lives in this repository goes in agents/ instead, with no entry here.
```

`agents/README.md`:

```markdown
# Team Subagents

Every Markdown file in this directory, except this README, installs as a
subagent on the workstation of each member of Group `team-payments`.
Wagglebot writes the file to every agent provider that supports
subagents, with the prefix `team-payments__`.

The file format is the same as in `company/agents/`: YAML front matter
with `name` and `description`, then the instructions.
```

`instructions/00-example.md`:

```markdown
## Team Instructions Example

Every Markdown file in this directory is appended after the company
instructions, for the members of Group `team-payments` only. Files are
appended in filename order. Replace this file with the conventions of
your team, or delete it.
```

`README.md` — replace the last line with:

```markdown
The scaffold creates each of these files. Every file except
`catalog.yaml` may stay empty or be deleted.
```

- [ ] **Step 3: Regenerate the reference app**: `bun run regen:test-app`, then `git status` shows the new files under `test-app/teams/team-payments/`.

- [ ] **Step 4: Run** `bun test packages/cli/e2e/scaffold.test.ts packages/cli/e2e/provisioning.test.ts` — PASS. `provisioning.test.ts` now also picks up the team instructions file for `alice`; confirm `~/.claude/CLAUDE.md` in that test still contains `## Memory`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/templates/init/teams test-app
git commit -m "Scaffold the six team files, not only the catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task D2: The scaffold declares the organization

**Files:**
- Modify: `packages/cli/templates/init/package.json`, `packages/cli/templates/init/README.md`
- Regenerate: `test-app/`

**Why:** Group A reads `wagglebot.organization` from the company `package.json` (D32, P33). The scaffold must carry the key and explain it.

- [ ] **Step 1: Edit `package.json`** — add after `scripts`:

```json
  "wagglebot": {
    "organization": []
  }
```

- [ ] **Step 2: Edit `README.md`** — add before "## Upgrade":

```markdown
## Pins

An entry in a `skills.list` or an `agents.list` that points outside
your organization must pin a tag. Wagglebot prints a warning for each
unpinned third-party entry. List the repositories that your
organization owns under `wagglebot.organization` in `package.json`, as
`host/path` prefixes:

    "wagglebot": { "organization": ["github.com/acme", "git.acme.local"] }

An entry under one of these prefixes may skip the pin, because a pull
request already reviews it.
```

- [ ] **Step 3: Regenerate**: `bun run regen:test-app`. Then `bun test packages/cli/e2e/scaffold.test.ts` — PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/templates/init/package.json packages/cli/templates/init/README.md test-app
git commit -m "Declare the organization in the scaffolded package.json

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task D3: The three first-party skills (D33)

**Files:**
- Create: `skills/writing-a-custom-agent/SKILL.md`, `skills/adding-an-mcp-server/SKILL.md`, `skills/onboarding-a-repository/SKILL.md`, `packages/cli/e2e/first-party-skills.test.ts`
- Modify: `packages/cli/templates/init/company/skills.list:13`, `packages/cli/src/commands/init.ts:12`, `docs/superpowers/specs/2026-08-28-wagglebot-design.md` (D33 row), `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md` (sections "First-party skills (D33)" and "The bundled skill (D33)")
- Regenerate: `test-app/`

**Why:** Spec success criterion 7 and D33. Nothing exists. The scaffold carries `# wagglebot/skills@<pin-me>   # first-party skills, not published yet`.

**Decision (recorded here, applied to the specs in this task):** the skills live in **this repository** under `skills/<name>/SKILL.md`, not in a separate `wagglebot/skills` repository. The `skills` CLI 1.5.23 discovers `skills/<name>/SKILL.md` in any repository (its README, "Skill Discovery"). Co-location delivers the reason D33 gives — "they version with wagglebot itself" — exactly, and needs no second repository or GitHub organization. The list entry is `swiknaba/wagglebot@v<version>`, and the scaffold substitutes the version so the skills pin follows the CLI pin.

**Skill format:** a directory with `SKILL.md`; YAML front matter with `name` (equal to the directory name) and `description` (one sentence that says when to use the skill); then the instructions in Markdown. Prose follows ASD-STE100. Before writing, read `skills/` conventions in the installed `superpowers` skills on this machine (`~/.claude/skills/*/SKILL.md`) for shape, and invoke the `writing-skills` skill for the checklist.

**Required content:**

`writing-a-custom-agent` (spec "The bundled skill (D33)" and D33, R2):
1. **Ask before any code:** "Is this agent for this repository only, or for the whole team?" Then explain the trade: this repository → `.agents/subagents/`, travels with the clone, no second reviewer; the team or the organization → `company/agents/` or `teams/<team>/agents/` in the company repository, or a repository of its own plus a line in `agents.list`, reaches every workstation, a second person reviews it. The skill never chooses.
2. **The default shape is a Markdown subagent** (D33): the file format is YAML front matter `name` and `description`, then the instructions; the installer prefixes the file name and writes it to every harness with a subagent directory. Show one complete example file.
3. **A runtime such as Flue only for durability or a sandbox** (R1): say what it costs (one API key per engineer) and tell the engineer to state the running cost in the pull request.
4. **What a useful subagent contains** (R2 question 4): one job, the inputs it needs, the output shape, the tool list, and a model tier when the harness supports one.

`adding-an-mcp-server` (D10, D13, P29, P31):
1. The `registry.yaml` entry shape: `namespace`, `mode` (one of `remote_http`, `remote_sse`, `stdio_npx`, `stdio_cmd`), `endpoint` or `command`/`args`, `env`, `auth: { scheme, source }`. Copy the allowed values from `packages/cli/src/registry.ts`.
2. The auth scheme against the credential source: `bearer`, `header`, `basic`, `env` schemes; `env` source with `var`; why `literal` is rejected and why `file` waits for the Phase 2 hub.
3. The pin rule: `stdio_npx` needs `pkg@x.y.z`, never a range or `latest` (P31).
4. Where the credential value lives: `.env.credentials`, gitignored, loaded by the shell block; `wagglebot update` reports an unset `${VAR}`.
5. Company layer or team layer: `company/registry.yaml` for everyone, `teams/<team>/registry.yaml` for one team; a team entry with the same namespace wins.
6. Show one complete `remote_http` entry and one complete `stdio_npx` entry.

`onboarding-a-repository` (D20, D29, D36, P35):
1. `catalog-info.yaml` at the repository root, or `.wagglebot/catalog.yaml` with the identical schema (D20): a Backstage `Component` with `spec.system` and `spec.owner` that name a System and a Group from the company catalog. Why no fallback exists: wagglebot never infers from a Git remote; an undeclared repository gets no system scope, and an unknown name is a hard error (P33, P35). Show one complete file.
2. `.agents/instructions/*.md` and `wagglebot sync-project` (D36): one portable source, written to every harness file in the repository.
3. `.agents/memory.md` (D29): committed, reviewed in pull requests, read by the agent at session start.
4. `.agents/subagents/` for a component subagent (D31).

**Consistency test** — `packages/cli/e2e/first-party-skills.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helper";

const skillsDir = join(repoRoot, "skills");
const REQUIRED = ["writing-a-custom-agent", "adding-an-mcp-server", "onboarding-a-repository"];

test("every first-party skill has a SKILL.md whose front matter name equals its directory", () => {
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  expect(dirs).toEqual([...REQUIRED].sort());
  for (const dir of dirs) {
    const text = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(front, `${dir}/SKILL.md has no front matter`).not.toBeNull();
    expect(front?.[1]).toContain(`name: ${dir}`);
    expect(front?.[1]).toMatch(/\ndescription: .+|^description: .+/m);
  }
});

test("writing-a-custom-agent asks where the agent belongs before any code", () => {
  const text = readFileSync(join(skillsDir, "writing-a-custom-agent", "SKILL.md"), "utf8");
  expect(text).toContain("this repository only, or for the whole team");
});
```

- [ ] **Step 1: Write the consistency test and run it** — `bun test packages/cli/e2e/first-party-skills.test.ts` — FAIL (no `skills/` directory).
- [ ] **Step 2: Write the three `SKILL.md` files** per the required content above.
- [ ] **Step 3: Update the scaffold.** `templates/init/company/skills.list` line 13 becomes:

```
swiknaba/wagglebot@v{{WAGGLEBOT_VERSION}}   # first-party skills for the wagglebot toolset; bump this pin together with the wagglebot pin in package.json
```

`init.ts:12`: `const SUBSTITUTED = new Set(["package.json", "README.md", "company/skills.list"]);`. Add a test to `init.test.ts` that the scaffolded `company/skills.list` contains `swiknaba/wagglebot@v` followed by the version passed to `runInit`.

- [ ] **Step 4: Update the specs.** Design doc D33 row: replace "in one repository, `wagglebot/skills`" with "in the wagglebot repository under `skills/`, installed from `swiknaba/wagglebot@v<version>`". Phase 1 spec "First-party skills (D33)": same replacement, and add one sentence: "The `skills` CLI discovers `skills/<name>/SKILL.md` in the repository, so the entry needs no path." Phase 1 spec "The bundled skill (D33)" item 1: replace "**The runtime.** How to write a Flue agent: the file shape, the hooks, and how to reach the local hub over MCP." with "**The shape.** A Markdown subagent by default (D33): YAML front matter with `name` and `description`, then the instructions. A runtime such as Flue only for durability or a sandbox (R1), with its running cost stated in the pull request."
- [ ] **Step 5: Regenerate and run**: `bun run regen:test-app && bun test && bun run check && bun run typecheck` — PASS.
- [ ] **Step 6: Commit (two commits)**

```bash
git add skills packages/cli/e2e/first-party-skills.test.ts docs/superpowers/specs/2026-08-28-wagglebot-design.md docs/superpowers/specs/2026-08-28-phase-1-provisioning.md
git commit -m "Add the three first-party skills (D33)

writing-a-custom-agent, adding-an-mcp-server, and onboarding-a-repository
live under skills/ in this repository, so they version with the CLI. The
skills CLI discovers skills/<name>/SKILL.md, so the list entry is
swiknaba/wagglebot@v<version>. The specs record that placement.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"

git add packages/cli/templates/init/company/skills.list packages/cli/src/commands/init.ts packages/cli/src/commands/init.test.ts test-app
git commit -m "Pin the first-party skills to the scaffolded wagglebot version

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Group E — Spec fixes and the last untested module

### Task E1: Fix two phase labels in the specs

**Files:**
- Modify: `docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md:226`, `docs/superpowers/specs/2026-08-28-service-contracts.md:396`

- [ ] **Step 1:** In the Phase 2 "Deployment Shape" table, change `The registry, memory, and (Phase 2) coordination` to `The registry, memory, and (Phase 3) coordination`.
- [ ] **Step 2:** In contracts §C3, change `Phase 1 ships only the \`session_run\` proposal path.` to `Phase 2 ships only the \`session_run\` proposal path.`
- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md docs/superpowers/specs/2026-08-28-service-contracts.md
git commit -m "Fix two phase labels in the Phase 2 and contracts specs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task E2: The Phase 1 spec describes hook ownership and the connection block as built

**Files:**
- Modify: `docs/superpowers/specs/2026-08-28-phase-1-provisioning.md` — section "Agent Base Template + Distribution" (the "connection block" sentences) and "Distribution" rule 1.

**Why:** Hook entries are owned by the `wagglebot:` marker in their command, not by a recorded key; that survives a lost state file and is the better mechanism, so the spec follows the code. The connection block's hub and coordination topics belong to Phases 2 and 3; Phase 1 carries the memory rule only.

- [ ] **Step 1:** In "Agent Base Template + Distribution", replace "It contains harness-independent instructions plus an wagglebot connection block. The connection block covers three topics: how to reach the hub, the propose-not-write memory rule, and coordination etiquette." with: "It contains harness-independent instructions plus a wagglebot connection block. In Phase 1 the block carries the memory rule. Component memory is a local file. A fact that crosses a repository waits for the shared store. How to reach the hub arrives with Phase 2, and coordination etiquette with Phase 3."
- [ ] **Step 2:** In "Distribution" rule 1, after "and it only ever rewrites those keys.", add: "Hook entries are the exception. Each entry the tool writes carries a `wagglebot:` marker in its command. Ownership follows the marker, so it survives a lost state file."
- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-28-phase-1-provisioning.md
git commit -m "Describe hook ownership and the connection block as built

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task E3: Test `exec.ts`

**Files:**
- Create: `packages/cli/src/exec.test.ts`

- [ ] **Step 1: Write the tests**

```ts
import { expect, test } from "bun:test";
import { realExec } from "./exec";

test("realExec returns stdout and exit code 0 on success", async () => {
  const result = await realExec(process.execPath, ["-e", "process.stdout.write('hi')"]);
  expect(result).toEqual({ code: 0, stdout: "hi", stderr: "" });
});

test("realExec returns the exit code and stderr of a failing command", async () => {
  const result = await realExec(process.execPath, ["-e", "process.stderr.write('bad'); process.exit(3)"]);
  expect(result.code).toBe(3);
  expect(result.stderr).toBe("bad");
});

test("realExec maps a command that does not exist to 127", async () => {
  const result = await realExec("wagglebot-command-that-does-not-exist", []);
  expect(result.code).toBe(127);
});

test("realExec runs in the given cwd", async () => {
  const result = await realExec(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: "/" });
  expect(result.stdout).toBe("/");
});
```

- [ ] **Step 2: Run** `bun test packages/cli/src/exec.test.ts` — PASS (this is a characterization test of existing behavior; if the 127 mapping test fails, read `exec.ts:9` and fix the test expectation, not the code).
- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/exec.test.ts
git commit -m "Test realExec: exit codes, streams, cwd, and a missing command

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Integration (main session)

### Task F1: Integrate the five group branches

- [ ] On `claude/phase-1-gap-closure`, cherry-pick each group's commits in order A, B, C, D, E (`git cherry-pick <first>^..<last>` per branch). Resolve conflicts in `install-agents.ts` (A adds the warnings loop; B changes `installFile` and the file filter) and in `README.md`.
- [ ] Run `bun install --frozen-lockfile && bun run check && bun run typecheck && bun test && bun run build && node packages/cli/bin/wagglebot.js --help`. Everything green.
- [ ] Remove the group worktrees and branches.

### Task F2: Review

- [ ] Dispatch a reviewer subagent per group with the plan and the diff of that group's commits: spec compliance first, then code quality. Fix findings in place as fixup commits squashed into the originating commit (`git rebase -i` is not available; use `git commit --fixup=<sha>` then `GIT_SEQUENCE_EDITOR=true git rebase --autosquash <base>`).

### Task F3: Prepare 0.2.0

- [ ] `packages/cli/package.json` version `0.1.0` → `0.2.0`.
- [ ] `README.md` "Status" blockquote: Phase 1 is complete, including the first-party skills and MCP configs for the verified harnesses; `sync-project` is part of it.
- [ ] `bun run regen:test-app` (the scaffold embeds the version); `bun test` green.
- [ ] Commit `Prepare 0.2.0` with a body that lists every base-template change (D35 requires the changelog to call those out; this release changes none unless Group D's spec edits touched `AGENTS.base.md` — they must not).

### Task F4: Pull request

- [ ] Push the branch and open the PR against `main`, body grouped by Bugs / Partial / Missing / Docs, ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### Task F5: Release (after merge, with the user)

- [ ] On `main`, run `bin/release` and select `minor`. The script verifies the version, the scaffold, tags `v0.2.0`, pushes, and creates the GitHub release; CI publishes to npm with provenance. `gh run watch` until green; `npm view wagglebot version` shows `0.2.0`.

---

## Self-Review

**Spec coverage.** Every bug in the gap analysis "Rough edges" list maps to a task: `index.ts:109` → A4; `sync-agents.ts:80-81` → B1; `isSha` → A2; `--update` rewrite and branch pin → A1; `update.ts:51-52` → A3; `install-agents.ts:93` → B4; `registry.ts:100` → C2; `backup.ts` stamp and `restoreSet` → B6; `managed-json.ts:53` → B3; `write-mcp.ts:85-88` → C1. Every "Partial" item maps: MCP writer → C3; skills-CLI dependency → A4; connection block → E2 (documented as Phase 2/3); backup rule 3 → B5; `chmod 600` → B2; hook ownership → E2 (spec follows code); team scaffold → D1; pin rule → A5 + D2. Every "Missing" item maps: first-party skills → D3; MCP adapters → C3. Not in scope, by decision: `.env.credentials` sourcing (trust model covers it); `limitBytes` and extra hook fragments (spec-sanctioned deferrals); `wagglebot validate` (D27, not a Phase 1 item — a follow-up).

**Placeholders.** None. Task C3 carries the vendor table, verified 2026-09-09, with a source URL per harness.

**Type consistency.** `resolveSkillsBin(): string | undefined` (A4) flows into `runInstallSkills.skillsBin` and `runUpdate.skillsBin`. `restoreSet` returns `RestoreResult` (B6) and `sync-agents.ts` consumes `.restored` and `.failed`. `parseList(text, options)` (A5) keeps the single-argument call in `repoOf`. `CompanyRepo.organization` (A5) is read in `index.ts` and `update.ts`, both owned by Group A. `subagentFiles` (B4) is local to `install-agents.ts`. `McpTarget` (C3) replaces the `{ path; parentKey }` shape; `help.ts:12-15` is updated in the same group.

---

## Deviations That Shipped

- `registry.ts` narrows `mode` with `isMode` and keeps one commented cast, not two.
- The loader rejects an `env` scheme on a remote mode, and it rejects `bearer`, `header`, and `basic` on a stdio mode (from the Group C review).
- The `basic` scheme has no `username` field (from the final review).
- A commented Gemini `settings.json` is skipped, not rewritten (from the final review).
