# Phase 1 Polish Review Handover

## Final integration review fixes

- Final receipt follow-up: Existing `0200` permissions let the shell write but prevented bootstrap verification. Rollback still returned child exit zero.
- RED: Ten receipt regressions failed with 27 assertions. Existing receipt symlinks also received unsafe writes, and rollback exceptions replaced child exit seven.
- Fix: Create an exclusive temporary receipt, set descriptor mode `0600`, and atomically replace the receipt path without symlink traversal.
- Receipt reads reject symlinks, non-regular files, and unsafe permissions.
- Settlement now emits one safe failure line, returns nonzero after child success, and preserves an existing nonzero child exit.
- GREEN: The ten receipt regressions passed with 70 assertions. Router/cache/shell suites passed 106 tests with 457 assertions.
- Final receipt verification: Nine E2E tests passed with 452 assertions. Seventeen documentation tests passed with 285 assertions.
- Check, typecheck, build, regeneration, fixture drift, package dry-run, and diff checks passed.
- Final full suite: 655 passed, three established failures, 3215 assertions across 658 tests and 87 files.
- Failures remain the two CodeGraph/Bun cases and sandbox SSH socket case. Prior authorized SSH evidence remains valid; no auth code changed.
- Final amended SHA: `a0030fbc059679a87065d6682d789092c7857938`. The parent task commit remains unchanged.
- Pre-stage status contained only the four intended source and test files. Staged diff checks passed, and post-amend status was clean.
- Close-review files: `company-cache.ts`, `index.ts`, and their test files. No credential values or second success summary are emitted.

- Scoped re-review reopened findings 2 and 4. The final review-fix commit was amended without another commit.
- Finding 2: A real partial upgrade left Codex and Cursor at v1 and the other adapters at v2.
- Raw-pin cleanup issued two removals. Both retained the shared canonical skill and reported failure.
- Fix: Group stale records by normalized repository identity. Remove the combined selected adapters and clear all corresponding records only after verified absence.
- Close-review files: `commands/install-skills.ts`, its tests, and `e2e/provisioning.test.ts`.
- Finding 4: Activation, npm, and early child failures disconnected old shell blocks. Partial shell failure removed the legacy path prematurely.
- Fix: Link the stable personal path without credential reads or copies. Keep the legacy link until the shell stage succeeds.
- A canonical revision receipt identifies shell success. A pending migration restores active on an earlier failure, without discarding later independent-stage failures.
- Existing separate personal credentials retain precedence. A runtime failure still restores their legacy loading path.
- Close-review files: `company-cache.ts`, `commands/sync-shell.ts`, `index.ts`, their transition tests, and the migration guide.
- Scoped RED: Real split-pin E2E had one pass and one failure. The identity-union regression had one failure.
- Scoped RED: Credential transitions had two passes and four failures. Separate stable-file runtime failure added one failing regression.
- Scoped GREEN: 173 focused tests passed with 718 assertions. All nine CLI E2E passed with 452 assertions.
- Scoped documentation: 17 tests passed with 285 assertions. Check, typecheck, build, regeneration, fixture drift, packaging, and diff checks passed.
- Scoped full suite: 645 passed, three established failures, 3145 assertions across 648 tests and 87 files.
- The two CodeGraph/Bun failures remain outside scope. The sandbox SSH socket failure has current authorized passing evidence outside the sandbox.
- Prior amended SHA: `8bd17e7c1813dc438469f8eac370d1d3d77278f7`. Nine intended paths changed during that scoped follow-up.
- The authorized SSH rerun passed one test with two assertions. One generated catalog fixture remained and was removed.
- Pre-stage status contained only the nine intended files. Staged diff checks passed. Post-amend status was clean.

- Finding 1: Normal MCP sync adopted unowned personal entries. The writer now preserves colliding unowned entries through later removal.
- Finding 3: Instruction overwrite removed ownership markers. Overwrite now renders one managed block from empty input.
- Finding 5: HTTP repository credentials entered saved settings and clone arguments. Connection and URL resolution now reject HTTP userinfo.
- Finding 7: Bare SCP URLs bypassed reserved-host checks. Host parsing now falls back to SCP when URL parsing has no hostname.
- RED: Nine focused failures reproduced these defects. Six additional router failures proved unsafe URLs reached the Git boundary.
- Close-review files: `commands/write-mcp.ts`, `commands/sync-harnesses.ts`, `company-url.ts`, `commands/connect.ts`, and their tests plus `index.test.ts`.
- Finding 2: Per-harness removal left shared skill files and locks. Provisioning now removes across the explicit adapter union before independent installs.
- Removal now verifies the installed dependency's JSON listing before it clears ownership. A failed union overwrite retries adapters independently.
- The real fixture now uses two path segments in its local SSH aliases. Skills 1.5.23 omits lock creation for one-segment URLs.
- Close-review files: `commands/install-skills.ts`, `commands/provision-company.ts`, their tests, and `e2e/provisioning.test.ts`.
- Finding 4: Cache activation disconnected personal credentials. Cached shells now select `~/.wagglebot/.env.credentials` outside immutable revisions.
- A legacy regular file shares the stable path until shell configuration succeeds. Wagglebot never reads or copies its values.
- Working-tree shells retain the root credential path. An existing stable file takes precedence without deletion of the legacy file.
- Close-review files: `company-cache.ts`, `paths.ts`, `commands/sync-shell.ts`, `index.ts`, the shell template, migration docs, and administrator E2E.
- Finding 6: Administrator instructions omitted dependency installation. Every active procedure now includes `npm install` before update.
- The offline procedure test installs a complete local package artifact, including external dependencies, through npm. It never substitutes only the shell script.
- Close-review files: onboarding and README procedures, scaffold guidance, `e2e/helper.ts`, and `e2e/administrator.test.ts`.
- Finding 8: Plain skill-pin updates accepted cache roots. Canonical path checks now reject active links and resolved revision roots before list writes or launches.
- Close-review files: `company-cache.ts`, `index.ts`, and `index.test.ts`.
- Commit: `a0030fbc059679a87065d6682d789092c7857938` — `Fix Phase 1 integration review findings`.
- Initial verification: 229 focused tests, 17 documentation tests, and all nine E2E tests passed. Initial final URL/cache tests passed 29 cases.
- Initial full suite: 638 pass, three fail, 3067 assertions across 641 tests. The scoped results above supersede these totals.
- The third full-suite failure was the sandbox SSH socket test. Its current authorized run outside the sandbox passed with two assertions.
- Check, typecheck, build, regeneration, staged fixture drift, package dry run, and diff checks passed.
- The package dry run used an isolated npm cache after the sandbox denied access to the personal npm log directory.
- Post-commit status is clean. All 13 task commits remain unchanged.
- Report: `.superpowers/sdd/2026-09-21-phase-1-polish/final-review-fix-report.md` contains exact RED/GREEN evidence and all changed paths.
- Residual limits: pinned skills listing format, existing filesystem rollback limits, and manual migration for files stranded in older inactive revisions.

## Task 12

- In progress: real offline company and project E2E tests precede fixture and CI changes.
- RED command: `bun test packages/cli/e2e/provisioning.test.ts packages/cli/e2e/sync-project.test.ts packages/cli/e2e/scaffold.test.ts`.
- Fixture failures expose the missing company marker and scaffold drift. The initial project assertion used the wrong memory heading.
- Test correction: the established template heading is `Component Memory`. No production change is required.
- Approved assumption: skills 1.5.23 does not parse tag fragments on file URLs. Exact temporary Git aliases map each ssh://offline.invalid source to a local file URL.
- Git permits only the file protocol. A mapping failure cannot fall back to network access.
- Test setup excludes inherited credentials and tool settings. HOME, XDG paths, and global Git configuration remain temporary.
- Close-review files: E2E helper, provisioning E2E, project E2E, scaffold E2E, regeneration script, test-app, and CI workflow.
- No production scope extension. No live harness, service, network fixture, or LLM is permitted.
- GREEN: seven E2E tests passed with 255 assertions. The three replacement tests also passed before the full E2E run.
- Dependency finding: skills 1.5.23 writes Codex, Gemini, Copilot, Cline, and Cursor skills to the shared .agents/skills directory.
- E2E checks the actual installed files and all ten ownership adapter IDs. No harness path or production behavior changed.
- Tagged source fixtures contain a later conflicting commit. Both real installers preserve the tagged content.
- The company E2E checks stage order, one summary, all instructions, custom agents, hook event keys, shell output, and parsed MCP commands.
- Two company updates preserve output bytes and keep the copied Git worktree clean. Skill-lock timestamps and cache Git metadata are outside byte comparisons.
- The project E2E checks init, update, all four physical targets, lifecycle preservation, source removal, empty-source repair, and committed lifecycle files.
- CI retains normal dependency installation and both Node smoke steps. Fixture regeneration and drift now have named steps after bun test.
- Local version smoke checks passed on Node v22.16.0 and v24.15.0 with the same artifact. Full E2E used Node v24.15.0.
- Limitation: Node v22.16.0 is older than the skills floor. The version smoke does not exercise its skill installer.
- Final regeneration, fixture drift, formatter, typecheck, and diff checks passed. Status inspection found only the intended Task 12 files.
- No required verification was unavailable. The full repository suite, packaging, and documentation remain Task 13 work.
- Report: .superpowers/sdd/2026-09-21-phase-1-polish/task-12-report.md contains RED/GREEN evidence and self-review.
- Commit: af86d689f3d2c4294f5def907742b062a5aec438 Verify Phase 1 through the offline test app.
- Post-commit git status --short is empty. This handover and the report remain local and uncommitted.

This file stays local and outside commits.

## Task 13

- Deviations: updated stale Task 12 catalog comments in their regeneration sources.
- Assumptions: vendor links describe the documented local adapters.
- Risks: full-suite failures remain outside Task 13.
- Changed tests: `packages/cli/src/help.test.ts` and `packages/cli/src/harness.test.ts`.
- Unavailable verification: `ssh-agent` is unavailable. Several unrelated service and local-brain fixtures failed.
- Limitations: no live harness or LLM session ran.
- Close-review files: the onboarding, migration, harness, and fixture documents.
- Review repair: registry test fixtures write `wagglebot.yaml`. Local-brain Git fixtures disable inherited commit signing per commit.
- Full-suite evidence: 610 passed and 3 failed. The remaining failures are the two Bun-incompatible CodeGraph SDK tests and sandbox-blocked SSH-agent test.
- Review repair: regenerated scaffold documentation removes clone, Yarn, harness detection, and selection guidance. Administrator flows now run `git init` before update. The harness reference now includes project targets, hook and MCP formats, and credential rules.
- Review repair round 2: `docs/harnesses.md` removes the false all-dialect
  credential statement. It now states registry-loader literal rejection once,
  file-source safe skips by dialect, default `mcpServers` ownership, and Codex
  `env_vars`, `bearer_token_env_var`, and `env_http_headers` rules.
- Review repair round 2: verified primary vendor links now identify Junie MCP
  settings, Devin Local and CLI, Cascade hooks, and Kiro MCP configuration.
  The focused documentation RED result was 13 pass and 1 fail. GREEN was 14
  pass and 0 fail. The scaffold-focused command was 18 pass and 0 fail.
- Review repair round 2: the legacy company scaffold command now includes
  `--wagglebot`. The team template treats `catalog.yaml` as optional, and the
  regenerated fixture has the same text. The administrator test now requires
  `cd mycompany-wagglebot` before it checks command order.
- Risks: the two CodeGraph tests require Node `node:sqlite` while the full suite
  runs under Bun. The SSH-agent test cannot bind its sandbox socket. These are
  outside Task 13. No live harness or LLM session ran.
- Close-review files: `docs/harnesses.md`, `docs/phase-1-onboarding.md`,
  `docs/phase-1-command-migration.md`, root and package README files, the init
  template and `test-app`, harness and help tests, and the status specification.
- Final review round 2 verification: formatter, typecheck, build, regeneration,
  and staged fixture drift passed. The package dry run listed 36 files,
  including `bin/wagglebot.js`, `dist/index.js`, `README.md`, and 32 templates.
  Full `bun test` reported 612 pass, 3 fail, and 2758 assertions across 615
  tests. The three known failures remain unchanged.
- Final minor correction: Codex now names the environment-map key. File
  credentials skip before dialect handling for every harness. The Devin row
  links to the direct MCP configuration page. The normalized negative assertion
  failed against the old newline-split wording, then the restored focused suite
  passed 18 tests with 310 assertions. Formatter, typecheck, regeneration, and
  fixture drift passed.

## Implementation notes

- The user required implementation on the existing `lud/phase-1-final` branch without another worktree.
- The implementation follows `docs/superpowers/specs/2026-09-21-phase-1-polish-design.md` and its task plan without design changes.

## Review queue

- Completed Task 1 commit: `2c9c611 Detect marked company repositories`.
- Completed Task 2 commit: `73750bb Add company repository connection settings`.
- Completed Task 3 commit: `728aef0 Add the validated company cache`.
- Completed Task 4 commit: `9c3c404 Run company updates with the pinned runtime`.
- Completed Task 5 commit: `2a4a6dc Support nine harness capability adapters`.
- Completed Task 6 commit: `d8a240e Add project initialization and updates`.
- Completed Task 7 commit: `423b3df Synchronize instructions and hooks for nine harnesses`.
- Completed Task 8 commit: `4565da9 Install skills and agents across all harnesses`.
- Completed Task 9 commit: `38916eb Write safe MCP configs for nine harnesses`.

## Task 1

- No deviations, assumptions, risks, unavailable verification, or limitations.
- Changed tests: `packages/cli/src/company.test.ts`, including the company-first catalog order test added during review, and `packages/cli/src/project-root.test.ts`.
- Close-review files: `packages/company-config/src/company.ts`, `packages/cli/src/index.ts`, and `packages/cli/src/commands/update.ts`.
- Commit: `2c9c611 Detect marked company repositories`.
- Review added the planned company-first catalog-order regression test. A controlled mutation proved that the test detects wrong ordering.

## Task 2

- No deviations from the Task 2 brief.
- Assumptions: repository URLs use standard URL or Git SCP syntax. A host whose name ends in `.example` is reserved documentation data.
- Risks: public `connect` routing and company update behavior remain owned by Task 11. This task only adds reusable URL resolution, local paths, and config persistence.
- Changed tests: `packages/cli/src/company-url.test.ts`, `packages/cli/src/commands/connect.test.ts`, and `packages/cli/src/paths.test.ts`.
- Unavailable verification: none.
- Limitations: `runConnect` stores the supplied URL and does not clone, authenticate, or route a command.
- Close-review files: `packages/cli/src/company-url.ts`, `packages/cli/src/commands/connect.ts`, `packages/cli/src/paths.ts`, `packages/cli/package.json`, and the three changed test files.
- Commit: `73750bb Add company repository connection settings`.
- Review fix: host-only SCP input such as `git@company.example` now counts as reserved `.example` data and cannot pass URL resolution. Added focused regression coverage.

## Task 3

- No deviations from the Task 3 brief.
- Assumptions: macOS, Linux, and WSL support relative directory symlinks. Native Windows remains out of scope.
- Risks: An existing `active.next` path blocks activation. The refresh preserves the usable active cache and reports the failure.
- Changed tests: `packages/cli/src/company-cache.test.ts` and `packages/cli/src/exec.test.ts`.
- Unavailable verification: none.
- Limitations: The cache refresh clones the local remote on each refresh. Runtime installation and public command routing remain out of scope.
- Close-review files: `packages/cli/src/company-cache.ts`, `packages/cli/src/exec.ts`, and the two changed test files.
- Commit: `728aef0 Add the validated company cache`.

## Task 4

- Deviations: none.
- Assumptions: callers provide the exact validated company pin. Native Windows remains outside the Phase 1 scope.
- Risks: runtime activation uses filesystem rename operations. A process interruption between activation renames can leave a stale runtime path.
- Changed tests: `packages/cli/src/pinned-runtime.test.ts`.
- Unavailable verification: none.
- Limitations: this task adds the runtime installer and executor only. Public command routing remains owned by later tasks.
- Close-review files: `packages/cli/src/pinned-runtime.ts` and `packages/cli/src/pinned-runtime.test.ts`.
- Commit: `9c3c404 Run company updates with the pinned runtime`.
- Review fix: `runPinnedRuntime` removes duplicate reserved hidden arguments, including `--flag=value` forms, before it appends authoritative state.
- Review fix round 2: separate value-taking options consume a following token only when it is a value, so missing values preserve ordinary option tokens.

## Task 5

- Deviations: none.
- Assumptions: later tasks provide the new hook fragments and MCP renderers. This task only provides the adapter table and array iteration.
- Risks: current hook and MCP behavior remains limited to the existing formats until later tasks implement the added adapter formats.
- Changed tests: `packages/cli/src/harness.test.ts`, `packages/cli/src/commands/write-mcp.test.ts`, `packages/cli/src/help.test.ts`, `packages/cli/src/index.test.ts`, and `packages/cli/src/commands/update.test.ts`.
- Unavailable verification: no broad suite ran. The Task 5 brief limits verification to the focused harness test, formatter check, and type check.
- Limitations: no hook formats, MCP rendering behavior, installer behavior, project lifecycle, or routing changes were added.
- Close-review files: `packages/cli/src/harness.ts`, `packages/cli/src/index.ts`, `packages/cli/src/commands/update.ts`, `packages/cli/src/commands/install-agents.ts`, `packages/cli/src/commands/sync-agents.ts`, `packages/cli/src/commands/write-mcp.ts`, and `packages/cli/src/help.ts`.
- Commit: `2a4a6dc Support nine harness capability adapters`.

## Task 6

- Deviations: none.
- Assumptions: `wagglebot sync-project` remains the compatibility route until Task 11 changes public routing.
- Risks: project update writes missing memory and changelog files before instruction publication. A failed instruction preflight can therefore leave those new files.
- Changed tests: `packages/cli/src/commands/project-update.test.ts`, `packages/cli/src/commands/project-init.test.ts`, and `packages/cli/e2e/first-party-skills.test.ts`.
- Unavailable verification: none.
- Limitations: this task does not add Task 11 command routing or hidden alias help behavior.
- Close-review files: `packages/cli/src/commands/project-update.ts`, `packages/cli/src/commands/project-init.ts`, `packages/cli/templates/agent-changelog.md`, `packages/cli/templates/AGENTS.base.md`, and `skills/onboarding-a-repository/SKILL.md`.
- Commit: `d8a240e Add project initialization and updates`.
- Review attention: the deterministic onboarding test checks the required owner/system instruction order. A fresh no-skill control and a current-skill scenario both refused to guess values. No LLM-backed repository test was added because the approved Phase 1 test contract forbids LLM use.
- Deferred minor: the project-update preflight comment says every file remains unchanged, but missing lifecycle files can already exist when preflight fails.

## Task 7

- Deviation: `packages/cli/src/commands/update.ts` also required the module import and function rename. No update behavior changed.
- Deviation: `restoreHarnesses` preserves the existing `sync-agents --restore` route while `runSyncHarnesses` has the exact requested interface.
- Assumption: an `owned-json-file` target named `wagglebot.json` is a dedicated Wagglebot document. Copilot and Kiro use these files.
- Assumption: Cursor and Cascade hook files can contain personal settings despite the capability table's `owned-json-file` label. Overwrite preserves unrelated keys there.
- Risk: Cursor documents no context output for `afterFileEdit`. Cascade documents output display, but does not guarantee agent context injection. Both deterministic hooks emit reminders. Global instructions also contain both durable rules.
- Changed tests: renamed `packages/cli/src/commands/sync-agents.test.ts` to `packages/cli/src/commands/sync-harnesses.test.ts`, and extended `packages/cli/src/managed-json.test.ts`.
- Verification: 36 focused tests passed with 346 assertions. `bun run check` and `bun run typecheck` passed.
- Unavailable verification: no installed harness directories were inspected. No live harness session tested reminder delivery. No broad test suite ran.
- Limitations: default merge requires strict JSON and preserves malformed targets through failure. Overwrite also requires valid shared JSON to preserve unrelated settings.
- Close-review files: `packages/cli/src/commands/sync-harnesses.ts`, `packages/cli/src/managed-json.ts`, both changed tests, all seven hook fragments, and router imports.
- Commit: `423b3df Synchronize instructions and hooks for nine harnesses`.
- Review ruling: Cursor documents `postToolUse` context injection, but the approved plan specifies `afterFileEdit`. No companion event was added because the user prohibited design changes. Review whether the approved mapping should change in a later design round.

## Task 8

- Assumptions: only the selected adapters and dedicated agent directories form the replacement scope. Unselected managed state remains intact.
- Path validation rejects symlinks, including targets inside home, because recursive replacement must not follow aliases.
- Close-review files: `packages/cli/src/commands/install-skills.ts`, `packages/cli/src/commands/install-agents.ts`, and `packages/cli/src/state.ts`.
- Changed tests: both installer tests, `state.test.ts`, and the new offline `e2e/skills-adapters.test.ts`.
- Initial RED: 35 passed and 22 failed. The real installed skills 1.5.23 accepted all ten adapters and rejected the invalid control.
- Self-review added guards for unlisted skill adapters, local prefix escapes, and destination file symlinks before the final verification.
- Deviation: directory validation also protects default mode. Symlinked directories, including links inside home, require a real directory.
- Assumption: dedicated targets end with `agents`, as declared by Task 5. Default cleanup preserves state for unselected harnesses.
- Risks: filesystem permission failures and concurrent filesystem changes have no transactional rollback. Existing filesystem exceptions can still abort an installer.
- Verification: 66 focused tests passed with 235 assertions. `bun run check`, `bun run typecheck`, and `git diff --check` passed.
- Unavailable verification: no live harness behavior or network installation was tested. No broad suite ran, as required by the brief.
- Limitations: the real dependency test verifies adapter acceptance through the exact offline list command. Task 10 still owns stage orchestration.
- Report: `.superpowers/sdd/2026-09-21-phase-1-polish/task-8-report.md` contains the full RED/GREEN command output.
- Commit: `4565da9071c680f0e61ca68419b89083f7d39f11 Install skills and agents across all harnesses` (amended after review fix 1).
- Review fix 1: the installed skills 1.5.23 dependency reports some removal failures with exit code zero. The guard now checks both output streams.
- Review fix 1: adapter removal warnings, aggregate removal errors, and scan warnings retain ownership. Successful overwrite adapters still clear their state.
- Removal-outcome risk: the guard follows the pinned diagnostic contract. Dependency upgrades require another check. Partial filesystem removal has no rollback.
- Review fix 1 evidence: seven new focused cases failed before the fix. All 73 focused tests, 276 assertions, formatter, typecheck, and diff checks now pass.

## Task 9

- Deviation: Task 5 already supplied the complete target loop. Task 7 already supplied `replaceJsonCategory`. This task reuses both.
- Deviation: `managed-json.ts` needed no production change. Its test now covers empty MCP category replacement.
- Assumption: registry variable syntax is `${NAME}`. The renderer converts this syntax to each supported dialect.
- Assumption: Cascade uses the `windsurf` dialect name from Task 5. It skips all credentialed entries.
- Self-review: new dialects reject file and literal credential sources, literal environment values, incompatible schemes, malformed references, and empty credential maps.
- Self-review: the current environment only controls missing-variable warnings. Tests use a sentinel credential and check configs and reports for disclosure.
- Self-review: unchanged JSON writes now record ownership. Later default runs can remove stale entries after an unchanged overwrite.
- Self-review: Codex overwrite handles quoted keys, Unicode escapes, nested tables, array tables, inline tables, dotted assignments, multiline strings, and marker-like string contents.
- Risk: the TOML filter is a lexical category filter, not a complete TOML validator. Incomplete strings and arrays fail before any write.
- Risk: existing file writes have no transaction or rollback for concurrent filesystem changes or late I/O errors.
- Changed tests: `mcp-dialects.test.ts`, `commands/write-mcp.test.ts`, and `managed-json.test.ts`.
- Verification: 86 focused tests passed with 399 assertions. `bun run check`, `bun run typecheck`, and `git diff --check` passed.
- Unavailable verification: none of the required commands. No live harness session or broad suite ran.
- Limitations: commented JSON retains the existing safe skip. Task 10 still owns stage orchestration and must pass the new optional `overwrite` argument.
- Close-review files: `packages/cli/src/mcp-dialects.ts` and `packages/cli/src/commands/write-mcp.ts`, especially `additionalEntry`, `removeTomlCategory`, and the ownership and backup boundaries.
- Commit: `38916eb9efa80a1285ee5bc3670c384e49dfb637 Write safe MCP configs for nine harnesses` (amended after review fix 1).
- Review fix 1: both reported TOML defects reproduced before implementation. RED: 31 focused tests passed and 2 failed.
- Review fix 1: overwrite now validates TOML before category removal. Invalid input retains all file bytes, reports failure, and permits later targets.
- Review fix 1: literal and bare keys return before Unicode decoding. Literal backslashes remain unchanged.
- Authorized dependency: `smol-toml@1.8.0`, with no runtime dependencies and declared Node `>= 18` support. No existing parser was available.
- Added scope: only `packages/cli/package.json` and `bun.lock` for the parser. No additional source files.
- Review fix 1 verification: 88 focused tests passed with 419 assertions. Formatting, typecheck, and diff checks passed.
- Node compatibility: parser import, valid input, and malformed-input rejection passed on Node v24.15.0.
- The parser validation supersedes the earlier incomplete-validation limitation. Existing I/O rollback and live-harness limitations remain.
- Review ruling: allow one direct Node-compatible TOML parser dependency because no existing parser is available and lexical validation allowed destructive overwrite. Review the package choice, package metadata, lockfile change, and runtime compatibility closely.

## Task 10

- Deviation: write-mcp.ts also changed to prevent backup initialization during overwrite. The public MCP interface remains unchanged.
- Deviation: Reporter lacks warning counts and item names. A provisioning-local wrapper supplies both without changes to the shared interface.
- Assumption: the legacy runUpdate wrapper remains until Task 11 replaces public bootstrap routing.
- The renamed company fixture now includes the mandatory company marker.
- Catalog preflight rejects YAML parser errors before the existing catalog reader can accept recovered data.
- Harness isolation permits independent work after thrown errors and malformed target failures.
- Risk: per-harness agent installation can repeat remote clone or fetch operations.
- Risk: existing installer writes have no transactional rollback after late filesystem errors.
- Changed tests: identity.test.ts, company-context.test.ts, commands/provision-company.test.ts, and commands/sync-shell.test.ts.
- Identity tests exposed ignored Git read and write failures. Both failures now stop identity collection with an error.
- RED: 22 passed and 15 failed. Identity error RED: 39 passed and 2 failed.
- GREEN: 41 focused tests passed with 188 assertions. Biome, TypeScript, and git diff --check passed.
- Unavailable verification: none of the required commands. No broad suite, live network install, or live harness session ran.
- Limitations: legacy public source/self-update behavior remains for Task 11. The shared Reporter summary outside provisioning remains unchanged.
- Close-review files: company-context.ts, commands/provision-company.ts, its tests, commands/write-mcp.ts, and identity.ts.
- Report: .superpowers/sdd/2026-09-21-phase-1-polish/task-10-report.md contains exact RED/GREEN command output.
- Commit: fb70958b5190e84803958e4ae41173d0d6437835 Provision the stable company and team layers.
- Review fix 1: Reporter.summary(true) includes all earlier item names and warning counts. The default summary and counts retain their existing behavior.
- Review fix 1: legacy stale-runtime, missing-yarn, failed-pull, and failed-yarn paths produce one complete named summary.
- Review fix 1: skills compare ownership within selected adapters. Two consecutive provisioning runs now report unchanged skills as ok.
- Review fix 1: unselected ownership, changed pins, changed adapters, stage continuation, backups, overwrite, and stale-source behavior remain covered.
- Review RED: 41 tests passed and six failed. The Reporter extension separately failed its new unit test.
- Review GREEN: 47 required tests passed with 223 assertions. Another 37 Reporter/skills tests passed with 140 assertions.
- Biome, TypeScript, and git diff --check passed. No required check was unavailable.
- Additional close-review files: report.ts, report.test.ts, and commands/install-skills.ts.
- The deferred repeated agent-fetch issue remains unchanged.
- Amended Task 10 commit: cf1b4c1ee7566e7ded431d70baa4833fb940226e.
- Authorized limitation: the legacy successful self-update child uses a separate Reporter. Task 10 preserves that boundary without a new cross-process protocol.
- Task 11 must test report and exit propagation through the replacement pinned-runtime route.

## Task 11

- In progress: routing, help, and company scaffold tests precede production changes.
- RED command: `bun test packages/cli/src/index.test.ts packages/cli/src/help.test.ts packages/cli/src/commands/company-init.test.ts`.
- RED result: 13 passed, 46 failed, 124 assertions. The legacy router lacks the requested public and hidden routes.
- Test setup correction: Git fixtures now isolate HOME and Git configuration. The first attempt inherited commit signing and failed during fixture creation.
- Approved file-list extension: `commands/sync-shell.ts` and `commands/provision-company.ts`, plus their directly affected tests if needed.
- Reason: cached company revisions have no node_modules. Shell sync must use the selected runtime script and retain the active cache as its company root.
- Preserve the working-tree shell default. Do not install dependencies into the active cache.
- Assumption: isolated runtime execution uses the existing Exec seam. Tests replace npm installation and runtime launch while retaining real router execution and local Git clones.
- Close-review files: index.ts, help.ts, sync-shell.ts, provision-company.ts, and the routing tests.
- GREEN: 65 routing/help/scaffold tests passed with 313 assertions. Biome and TypeScript passed.
- Additional verification: 48 shell/provisioning/runtime tests passed with 219 assertions. git diff --check passed.
- A controlled mutation removed shellScriptPath forwarding. The cached-shell test failed before the forwarding line was restored.
- Self-review added first-refresh failure, runtime install failure, child exit/output propagation, working-tree shell routing, and equals-form hidden-root coverage.
- Test fixture correction: an empty MCP registry correctly creates no file. The route fixture now contains a valid stdio entry.
- Scope: the shell and provisioning source extension is limited to optional shellScriptPath and its forwarding. Working-tree defaults remain unchanged.
- Risk: the runtime installer validates its binary, not all package assets. A missing selected shell script reports failure.
- Limitations: tests replace npm installation and runtime launch at Exec boundaries. No live network, harness, or LLM ran.
- No required verification was unavailable. Task 12 retains E2E regeneration and drift work. Task 13 retains full documentation and packaging verification.
- The legacy runUpdate function remains for direct callers and tests. The public router does not invoke it.
- Report: .superpowers/sdd/2026-09-21-phase-1-polish/task-11-report.md contains exact RED/GREEN evidence.
- Commit: b8b42d8c21fa9eba3ac5ea3bb9e6339156c58021 Route project and company commands.
- Post-commit git status --short is empty. The report and handover remain local and uncommitted.
- Review fix 1 RED: 67 passed and six failed. Two tests observed cached list rewrites. Three real Node children timed out during first identity collection.
- The sixth failure proved that runPinnedRuntime still selected buffered execution instead of the injected interactive boundary.
- Review fix 1: added a separate inherited-stdio runtime executor. Public cached routes use it. Ordinary buffered Exec remains unchanged.
- Review fix 1: explicit and hidden cached skill-pin updates reject before runtime selection or mutation. Marked working-tree skill-pin updates remain available.
- Added scope: pinned-runtime.ts, pinned-runtime.test.ts, and pinned-runtime-subprocess.test.ts for the authorized interactive execution fix.
- Real subprocess tests use a locally built package, preinstalled runtime fixture, local Git source, and isolated HOME/Git configuration.
- The subprocess tests check prompt visibility, input after the prompt, queued stdin, username storage, one summary, and stale-source exit failure.
- Runtime unit tests continue to cover stdout/stderr forwarding and exact numeric exit codes without duplicate output.
- Review GREEN: 68 required tests passed with 324 assertions. Biome and TypeScript passed.
- Review affected-boundary GREEN: 58 tests passed with 254 assertions. This includes ordinary buffered Exec, real Node children, provisioning, and shell behavior.
- git diff --check passed. No required verification remains unavailable.
- Test setup correction: in-process Bun.build failed without prior router imports. A separate Bun build process resolves dependencies correctly and preserves test isolation.
- The real subprocess tests ran on Node v24.15.0. No live registry installation, harness, or LLM ran.
- The earlier injected-runtime limitation is superseded by the added real-subprocess coverage.
- Additional close-review files: pinned-runtime.ts and pinned-runtime-subprocess.test.ts.
- Amended Task 11 commit: 597146c6eed40b0cd8d415822fada716a1167a9e Route project and company commands.
- Post-amend git status --short is empty. The report and handover remain uncommitted.
