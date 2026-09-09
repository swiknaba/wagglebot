---
name: writing-a-custom-agent
description: Use when an engineer asks for a new custom agent, subagent, specialist, or Flue agent, and before any agent file exists.
---

# Writing A Custom Agent

## Overview

A custom agent is a reusable specialist that an engineer invokes on demand.
Placement decides who reviews the agent and who receives it. Ask about
placement first. The engineer chooses, and this skill explains the trade.

Wagglebot distributes a custom agent. Wagglebot never runs one (D31).

## Step 1: Ask Where The Agent Belongs

Ask this question before you write any code:

> Is this agent for this repository only, or for the whole team?

Wait for the answer. Then explain the trade for that answer.

| Answer | Where the file goes | What the engineer gets |
|---|---|---|
| This repository | `.agents/subagents/` in this repository | Git distributes it with every clone. No second team reviews it. It disappears in a different repository. |
| The team or the organization | `company/agents/` or `teams/<team>/agents/` in the company repository | `wagglebot update` installs it on every workstation. A second person reviews the pull request. |
| A separate repository | A repository of its own, plus one line in `company/agents.list` | The same reach, and the agent keeps its own release history and pin. |

Never choose for the engineer. State the trade, then follow the answer.

## Step 2: Write A Markdown Subagent

A Markdown subagent is the default shape (D33). It rides the AI that the
engineer already runs, so it needs no API key and it reaches everyone.

The file holds YAML front matter with `name` and `description`, then the
instructions:

```markdown
---
name: migration-planner
description: Plans one database migration. Use before a schema change lands.
---

Plan one database migration for the service in this repository.

Inputs: the current schema file, the wanted change, and the deploy window.

Steps:
1. Read the current schema.
2. Write the forward migration and the matching rollback.
3. List every query that the change breaks.

Output: one Markdown plan with both migrations and a risk list.

Tools: file read, file write, and the repository test command. Request no
network access.
```

The installer copies the file to every harness that reads Markdown
subagents, for example `~/.claude/agents/`. It adds a prefix to the file
name, such as `company__` or `team-payments__`. A harness without a
Markdown subagent directory is skipped with one log line.

Keep the front matter to `name` and `description`. Wagglebot copies the
file unchanged, so a harness-specific field also reaches harnesses that
do not know it.

## Step 3: Check What The Subagent Contains

A useful subagent states five things (R2):

1. **One job.** One agent, one task. Split a second task into a second agent.
2. **The inputs it needs**, by name: files, paths, and identifiers.
3. **The output shape**: the format, the sections, and the length.
4. **The tools it may use**, and the tools it must not use.
5. **The model tier**, when the target harness supports one. Name the tier
   in the instructions for a portable agent.

An agent without a stated output shape returns prose that nobody can use.

## When A Runtime Such As Flue Earns Its Cost

Choose a runtime such as Flue only for durability or a sandbox (R1). A Flue
agent survives a crash and runs unattended. It also costs one API key for
each engineer, and a harness-bundled AI exposes no such key.

State the running cost in the pull request. Name the key, the model, and
who pays. A team that cannot answer those three points wants a Markdown
subagent instead.

## Quick Reference

| Question | Answer |
|---|---|
| Default shape | A Markdown subagent |
| Required front matter | `name` and `description` |
| One repository | `.agents/subagents/`, no list entry |
| Whole company | `company/agents/`, no list entry |
| One team | `teams/<team>/agents/`, no list entry |
| Own repository | One line in `company/agents.list` |
| Pin rule | A third-party repository must pin a tag (D32) |

A repository inside your organization may skip the pin when `package.json`
lists its host/path prefix under `"wagglebot.organization"`.

## Common Mistakes

| Mistake | Fix |
|---|---|
| The skill picks the placement | Ask the question, then explain the trade |
| One agent with three jobs | Write three agents |
| A README file in `agents/` becomes an agent | The installer skips `README.md` only |
| An unpinned third-party entry in `agents.list` | Add `@<tag>` (D32) |
| A Flue agent for a job that needs no sandbox | Write a Markdown subagent |
