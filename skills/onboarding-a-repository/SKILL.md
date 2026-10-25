---
name: onboarding-a-repository
description: Use when a repository joins wagglebot, or when it has no catalog-info.yaml, no project instructions, no memory file, and no component subagents.
---

# Onboarding A Repository

## Overview

A repository declares what it is. Wagglebot never derives an identity from
the directory layout or from a Git remote (P33, P35). Four files give a
repository everything that wagglebot and an agent need. The catalog file also
prepares the repository for the Phase 2 shared layer.

| File or directory | Purpose | Committed |
|---|---|---|
| `catalog-info.yaml` | The component, its system, and its owner (D20) | Yes |
| `.agents/instructions/*.md` | One portable instruction source (D36) | Yes |
| `.agents/memory/` | The local OKF bundle: an index and one concept per file (D29) | Yes |
| `.agents/subagents/*.md` | Subagents for this repository only (D31) | Yes |

## Step 1: Get Catalog Values

Ask the engineer for the component owner and system. Get both values before you write `catalog-info.yaml`.
Do not derive either value from the directory or Git remote.

## Step 2: Declare The Component

Write `catalog-info.yaml` at the repository root. A repository that prefers a
hidden directory uses `.wagglebot/catalog.yaml` with the identical schema.

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payments-api
  description: The public payments API.
spec:
  type: service
  lifecycle: production
  owner: team-payments
  system: payments-platform
```

`spec.owner` names a Group, and `spec.system` names a System. Both names must
already exist in the company catalog. The company repository holds that
catalog in `company/catalog.yaml` and in each `teams/<team>/catalog.yaml`.

**No fallback exists, and that is deliberate.** Wagglebot reads no Git remote
and no directory name. A repository name fits neither a monorepository team
nor a microservice team (P33). Two results follow:

* An undeclared repository gets no system scope. Memory for that repository
  stays local, and no shared search covers it. Shared memory search arrives
  with Phase 2 (D29). Declare the file now, so that layer reads it without a
  change.
* An unknown Group or System name is a hard error when the shared layer reads
  the file (Phase 2). Wagglebot never invents an identifier, because a silent
  invention writes facts into a space that no search reads (P35).

Add the missing Group or System to the company catalog first. Then merge the
`catalog-info.yaml` file.

## Step 3: Write The Project Instructions

Repository instructions belong to the repository. Write portable Markdown in
`.agents/instructions/`, one file for each topic:

```
.agents/
  instructions/
    00-code-style.md
    10-testing.md
```

Run `wagglebot update` in the repository. The command finds the Git
root, sorts the source files by name, and writes one managed block for each
harness target.

| Harness | Project target |
|---|---|
| Codex, Junie, Cline, Cursor, Devin, and Kiro | A managed block in root `AGENTS.md` |
| Claude Code | A managed `@AGENTS.md` import in root `CLAUDE.md` |
| Gemini CLI | A managed `@./AGENTS.md` import in root `GEMINI.md` |
| GitHub Copilot CLI | A managed block in `.github/copilot-instructions.md` |

The command needs a Git repository only. It needs no company repository, no
catalog, and no engineer identity. It keeps every line outside its managed
block. Commit the generated files together with the source files.

Edit the files under `.agents/instructions/` only. A later `wagglebot update` run
overwrites each managed block.

## Step 4: Work With Component Memory

Start with `.agents/memory/index.md`. Read only linked concepts that matter
to the task. Do not read the whole bundle up front.

Keep one concept per file. Store each durable fact in one non-reserved
Markdown file under its matching category. Edit an existing concept instead
of duplicating it, and tell the engineer when facts conflict.

When the engineer explicitly asks you to remember a fact, skip the importance
judgment and create or update one concept. When they correct a fact, remove it
or update the concept.

Run `wagglebot update` to validate concepts and regenerate indexes. Do not
hand-edit `index.md`. Commit concept and index changes for Git and pull-request
review.

A cross-repository fact belongs in the future shared layer. Never copy it into
another repository's local bundle.

## Step 5: Add A Component Subagent

A subagent that serves this repository only lives in `.agents/subagents/`
(D31). Git distributes it, so it needs no entry in any `agents.list`. Write
the same Markdown file format: YAML front matter with `name` and
`description`, then the instructions.

For an agent that a whole team needs, read the `writing-a-custom-agent` skill.

## Common Mistakes

| Mistake | Fix |
|---|---|
| `spec.system` names a System that no catalog declares | Add the System to the company catalog first |
| An agent guesses a scope from the Git remote | Stop. Declare the component (P35) |
| `.agents/memory/` in `.gitignore` | Remove that line. Git must review local memory changes |
| A generated `index.md` edited by hand | Edit the concept, then run `wagglebot update` |
| Memory merged into project instructions | Keep concepts under `.agents/memory/`; only `.agents/instructions/*.md` is an instruction source |
| Instructions edited in `AGENTS.md` | Edit `.agents/instructions/*.md`, then run `wagglebot update` |
| A component subagent added to `agents.list` | Delete the entry. Git already distributes the file |
