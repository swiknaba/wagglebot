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
| `.agents/memory.md` | Facts about this repository (D29) | Yes |
| `.agents/subagents/*.md` | Subagents for this repository only (D31) | Yes |

## Step 1: Declare The Component

Put `catalog-info.yaml` at the repository root. A repository that prefers a
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
* An unknown Group or System name is a hard error. Wagglebot never invents an
  identifier, because a silent invention writes facts into a space that no
  search reads (P35).

Add the missing Group or System to the company catalog first. Then merge the
`catalog-info.yaml` file.

## Step 2: Write The Project Instructions

Repository instructions belong to the repository. Write portable Markdown in
`.agents/instructions/`, one file for each topic:

```
.agents/
  instructions/
    00-code-style.md
    10-testing.md
```

Run `wagglebot sync-project` in the repository. The command finds the Git
root, sorts the source files by name, and writes one managed block for each
harness target.

| Harness | Project target |
|---|---|
| Codex, Junie, and Cline | A managed block in root `AGENTS.md` |
| Claude Code | A managed `@AGENTS.md` import in root `CLAUDE.md` |
| Gemini CLI | A managed `@./AGENTS.md` import in root `GEMINI.md` |
| GitHub Copilot CLI | A managed block in `.github/copilot-instructions.md` |

The command needs a Git repository only. It needs no company repository, no
catalog, and no engineer identity. It keeps every line outside its managed
block. Commit the generated files together with the source files.

Edit the files under `.agents/instructions/` only. A later `sync-project` run
overwrites each managed block.

## Step 3: Commit The Memory File

An agent records a fact about this repository in `.agents/memory.md`. That
file is **committed**, never gitignored (D29). Three results follow:

* The fact appears in `git status`, so a pull request reviews it.
* Git distributes the file to everyone who clones the repository.
* The agent reads the file at the start of a session, with no server call.

A fact that crosses a repository boundary belongs to a `system`, `domain`, or
`org` scope in the shared store instead. A fact about this repository stays
here.

## Step 4: Add A Component Subagent

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
| `.agents/memory.md` in `.gitignore` | Remove that line. The review is the feature |
| Instructions edited in `AGENTS.md` | Edit `.agents/instructions/*.md`, then run `wagglebot sync-project` |
| `.agents/memory.md` merged into the instructions | Only `.agents/instructions/*.md` is an instruction source |
| A component subagent added to `agents.list` | Delete the entry. Git already distributes the file |
