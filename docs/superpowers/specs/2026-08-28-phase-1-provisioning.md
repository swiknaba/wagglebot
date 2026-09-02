# Phase 1 — Workstation Provisioning

> Companion to the [wagglebot design spec](2026-08-28-wagglebot-design.md).
> One team shares one curated agent environment: the same skills and the
> same base instructions, on every workstation and in every agent
> harness. This tooling ships inside the `wagglebot` npm package (D35).
>
> **This is the whole of Phase 1 (D14).** Zero services run. One
> central git repository and one command provision a workstation.

## The Update Command (D34, D35)

Wagglebot arrives as a **pinned npm dependency** of the company
repository, never as cloned source (D35). The engineer flow is three
commands, and only the last repeats:

```
git clone <company repo>
yarn install            # materializes the pinned wagglebot CLI
yarn update:wagglebot    # the package script alias for `wagglebot update`
```

The scaffolded `package.json` carries the alias:

```json
{
  "dependencies": { "wagglebot": "1.4.2" },
  "scripts": { "update:wagglebot": "wagglebot update" }
}
```

`wagglebot update` does four things:

1. `git pull --ff-only` on the company repository.
2. `yarn install`, when the wagglebot pin moved. The CLI therefore
   updates itself through the normal dependency path, and the pin bump
   is a reviewed pull request, never a silent upgrade.
3. Run the installers, in order: `install-skills`, `install-agents`,
   `sync-agents`, `sync-shell`, and the MCP config writer.
4. Print a summary: current, updated, and failed items.

`wagglebot update --help` explains what the command touches, file by
file, and where the managed blocks live.

Rules:

* **Idempotent.** A second run changes nothing and says so.
* **Non-destructive.** Every harness file is written inside a managed
  block. Content outside the block stays untouched (F22).
* **No service.** Phase 1 installs files. Nothing listens on a port.
* **No auth.** Git access to the company repository is the whole
  permission system (D14, D15).
* **No fork.** The installers, the base template, and the harness
  target table live in the package. The company repository holds only
  company content, so a wagglebot upgrade is a one-line pin bump
  (D35).

**The engineer identity is stored, never guessed.** `wagglebot update`
needs the company Git username to find the team in `catalog.yaml`.
`git config user.name` is a display name and `user.email` is an email,
so neither is that username. The first run asks once, validates the
answer against the User entities in `catalog.yaml`, and stores it:

```
git config --global wagglebot.username alice
```

Every later run reads that key. An answer that matches no User entity
is rejected with the list of near matches, never accepted silently
(P35).

**MCP configs are written, not proxied (Phase 1).** The update command
reads `company/registry.yaml` and each `teams/<team>/registry.yaml`,
finds the team of the engineer in `catalog.yaml` by git username, merges shallowly, and
writes the result into each harness MCP config, inside the managed
block. Credentials resolve locally per D10: the config names an
environment variable, and the value stays in `.env.credentials`.
The Phase 2 hub replaces this written config when the tool count needs
aggregation (see the
[phase 2 spec](2026-08-28-phase-2-shared-layer.md)).

**Harness selection.** Wagglebot provisions every harness whose home
directory already exists, for example `~/.claude` or `~/.codex`. An
engineer overrides detection with an explicit, comma-separated list:

```
git config --global wagglebot.harnesses claude-code,codex
```

That key wins over detection whenever it is set. An unknown name in
the list is a hard error, and it names the valid harnesses.

**Credentials reach the shell.** `sync-shell` adds a managed block to
`~/.zshenv` (and to `~/.bashrc`, when that file already exists) that
sources `templates/shell/wagglebot.sh`, a script the wagglebot package
ships. That script exports every line of the company repository's
gitignored `.env.credentials` file into the shell. An agent harness
started from a new terminal then sees the variables, and can expand
`${VAR}` in its MCP config.

## Company Repository Layout

`company/` and every `teams/<team>/` directory share one shape. The
team directory name must equal the Group name in `catalog.yaml`.

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

Every `catalog.yaml` merges into one catalog. A `teams/<team>/`
directory that names no matching Group is a hard error.

## Curated Skills List

`company/skills.list` and `teams/<team>/skills.list`, in the company
repository, are versioned lists of skill packages. The format is one
**pinned** entry per line: `owner/repo@<ref>`. Comments are allowed.

The skills CLI checks out a tag or a branch, never a commit hash, so a
skills pin is always a tag. `install-skills` rejects a commit-hash ref.

Seed content, both real entries:

```
obra/superpowers@v6.3.0
ayghri/i-have-adhd@main
```

**One pin rule covers every list** (D32). An entry outside your
organization **must** carry a pin, because a third party controls what
that repository publishes next (P31, D13). An entry inside your
organization **may** carry one, and a pull request already reviews it.
Every seed entry above is third-party, so every seed entry pins.

### First-party skills (D33)

Wagglebot ships with a specific toolset, so it ships the skills for
that toolset. They live in **one repository**, `wagglebot/skills`,
because they version with wagglebot itself. A registry format change
breaks `adding-an-mcp-server` on the same day, so the two must move
together.

| Skill | Teaches |
|---|---|
| `writing-a-custom-agent` | Which shape to use, and the file format for it. It asks where the agent belongs before it writes code (D33). **The default is a Markdown subagent.** A Markdown subagent uses the AI the engineer already has, so it needs no API key and it reaches everyone. Reach for a runtime such as Flue only for durability or a sandbox, and say in the pull request what the agent costs to run. |
| `adding-an-mcp-server` | A `registry.yaml` entry: the auth scheme against the credential source (D10), the pinning rules (D13), the trust approval (P29), and why a literal secret is rejected. |
| `onboarding-a-repository` | `catalog-info.yaml`: which system, which owner, and why no fallback exists (D20, P35). |

`publishing-team-knowledge` is a candidate, and it waits. Add it when
somebody publishes to a domain scope for the first time.

### What belongs in a skill, and what belongs in the base template

The two carry different costs:

| | Loaded | Cost |
|---|---|---|
| `AGENTS.base.md` | Every session, in every harness | Context, always |
| A skill | On demand | None until used |

The rule follows from that:

* **Always needed → the base template.** The memory rules qualify,
  because the agent may write memory at the end of any session.
* **Occasionally needed → a skill.** Everything else about wagglebot
  qualifies.

Apply the rule to each new feature. Without it, every feature gets
appended to the base template, and the template stops being readable.

## Skills Installer

`install-skills` (part of the wagglebot package, D35) is idempotent and reproducible:

1. Install the `skills` npm CLI at the **pinned version** that the
   wagglebot package declares in its own dependencies, when it is
   missing or differs.
2. Run `skills add <entry> -g -y` for every pinned line in
   `skills.list`.
3. Never auto-update. Updates happen through one explicit command,
   `install-skills --update`, which bumps the pins in `skills.list` for
   review.

Behavior: colored section output, and counters for installed, updated,
ok, and failed items. When a dependency (npm, skills) is absent, the
script warns and continues. The script exits non-zero on failures.

## Custom Agent Distribution

A team writes its own agents, in a runtime such as
[Flue](2026-08-28-research-list.md) or any other. Wagglebot
**distributes** those agents. It never runs one (D31).

### Two kinds, two mechanisms

| Kind | Lives in | Distributed by |
|---|---|---|
| **Component agent** — useful for one repository | `.agents/subagents/` in that repository | Git. Nothing to do. |
| **Company agent** — useful for the whole company | `company/agents/` | `wagglebot update`, with no list entry |
| **Team agent** — useful for one team | `teams/<team>/agents/` | `wagglebot update`, with no list entry |
| **Shared agent** — useful for a team or the organization | A repository of its own | The list below |

A component agent needs no wagglebot feature. Git already gives it to
everyone who clones the repository, a pull request reviews each change,
and the history is free. This mirrors component memory (D29).

The list stays for a shared agent maintained in a repository of its own,
separate from the company repository.

### The lists

Two layers, which compose the same way the registry does:

```
company/agents.list               # every engineer
teams/<team>/agents.list          # members of Group <team>
```

Company agents authored in this repository live in `company/agents/`.
Team agents live in `teams/<team>/agents/`. Both directories install
through `wagglebot update`, with no list entry.

One entry per line. A GitHub repository is written as `owner/repo`,
with an optional `@<ref>`. A repository on any other git host is
written as its full clone URL, followed by an optional ref after a
space. Comments are
allowed.

Wagglebot ships the mechanism and an **empty** list with commented
examples. The content belongs to one installation, so this repository
never carries it. That matches `registry.yaml`.

### Distribution is automatic (D32)

In Phase 1, `wagglebot update` installs and updates the list — one
command, run by the engineer or a shell hook.

From Phase 2, the hub fetches the registry from the shared layer on
refresh, carries the agent list on the same request, and **installs or
updates each agent without asking**. An engineer then does nothing: a
team publishes an agent, and it appears on every workstation.

`install-agents` still exists, for a first setup and for a manual
refresh. It is not the normal path.

### Agents work the same way as skills

Both are Markdown in a git repository, curated centrally, installed on
every workstation. The mechanism is therefore the same, and one pin
rule covers both:

| Entry points at | Pin |
|---|---|
| A third party, for example `obra/superpowers` | **Required.** They control the next release. |
| Your own organization | Optional. A pull request already reviews it. |

That rule replaces the earlier split between the two lists. A pin on
your own repository would guard against your own colleagues, which
contradicts D15.

Two differences remain, and both are small:

1. **Destination.** A skill goes to the skill directory. A subagent
   goes to the subagent directory of each harness. For Claude Code
   that is `~/.claude/agents/`. The other harness locations are open
   ([research list R2](2026-08-28-research-list.md)), and a harness
   with no subagent support is skipped with one log line.
2. **Refresh.** In Phase 1, `wagglebot update` installs the list. From
   Phase 2, the hub carries it on the registry refresh, so a shared
   agent arrives without any command.

### Contribution

A team contributes an agent in three steps:

1. Write the agent in its own repository.
2. Open a pull request that adds the entry to `company/agents.list`, or
   to a team list.
3. On merge, every workstation picks it up at the next hub refresh.

Review of that pull request is the control. Repository write access
stays the only permission system (D15).

### The bundled skill (D33)

Wagglebot ships one skill, `writing-a-custom-agent`, in the curated
set. It teaches an agent how to help an engineer write a new custom
agent.

The skill covers:

1. **The runtime.** How to write a Flue agent: the file shape, the
   hooks, and how to reach the local hub over MCP.
2. **The placement question, asked before any code.** The skill must
   ask the engineer:

   > Is this agent for this repository only, or for the whole team?

   | Answer | Where it goes |
   |---|---|
   | This repository | `.agents/subagents/` in this repository |
   | The team or the organization | Its own repository, plus a pull request on `company/agents.list` |

3. **The consequences of each answer**, so the engineer chooses well. A
   local agent needs no review from another team, and it disappears
   when somebody clones a different repository. A shared agent reaches
   every workstation, so a second person reviews it.

The skill never chooses for the engineer. It asks, and it explains the
trade.

## Agent Base Template + Distribution

`AGENTS.base.md` ships inside the wagglebot package (D35) as the
**shared agent base template**. It contains harness-independent instructions plus an
wagglebot connection block. The connection block covers three topics:
how to reach the hub, the propose-not-write memory rule, and
coordination etiquette. Teams append company instructions from the
company repository. Composition is plain concatenation:
`AGENTS.base.md` + `instructions/*.md` → the rendered template. YAGNI: no
templating engine. The base is never edited in place: a company
extends through the company instructions, so a wagglebot upgrade never
conflicts (D35).

The base template carries three sections: a delegation policy, a
writing baseline, and a memory policy. All three are portable across
harnesses and across teams.

The memory section is **required**, not optional. The agent extracts its
own memory (D24), so the rules must reach the agent. A server policy
file cannot do that job.

Workstation-specific content stays out of the base template. Version
managers, shell paths, and machine setup differ per person and per
team. Put that content in a company instructions file.

### Seed content for `AGENTS.base.md`

The template ships with this delegation section:

```markdown
## Delegation

You usually run as the most expensive model in the session.
Protect your tokens and your context window.
If the harness supports subagents, delegation is the default, not the exception.

DEFAULT TO DELEGATION

Before each multi-step task, plan which steps a subagent can do.
Delegate these task types:

* Codebase search and file exploration.
* Reads of many files to answer one question.
* Mechanical edits across many files.
* Implementation of a task that a written plan fully specifies.
* Test runs, log analysis, and other verification with a clear pass signal.

Keep these task types in the main session:

* Architecture and plan decisions.
* Debugging with an unclear cause.
* Review of subagent output.
* Small edits where delegation costs more than the edit.

MODEL TIERS

When the harness lets you select a subagent model, apply these tiers:

* Use the cheapest tier (for example, Haiku) for search, summaries, and mechanical edits.
* Use the middle tier (for example, Sonnet) for implementation of specified tasks.
* Reserve the top tier for the main session.

SUBAGENT PROMPTS

* Write each subagent prompt as a self-contained task, because the subagent has no session context.
* State the goal, the relevant files, the constraints, and the expected output format.
* Review each result before you accept it.
* Do not repeat delegated work in the main session without cause.

SKILLS

If a subagent-driven-development skill is available, invoke it before you execute a plan with independent tasks.
If a dispatching-parallel-agents skill is available, invoke it when two or more tasks are independent.
Re-read this section when you start a plan and when you complete a plan phase.
```

The delegation section names the skills by their skill name only. It
does not pin a version. The curated `skills.list` controls which
skills exist on the workstation.

The template also ships with this baseline section:

```markdown
## Baseline

You are a coding and technical-writing agent.

Apply ASD-STE100 Issue 9 to the prose that you create or revise.

PRIORITIES

1. Preserve technical accuracy and the user's intended meaning.
2. Preserve the required format and all executable code.
3. Apply the STE rules to prose.

If rules conflict, follow the higher priority.

SCOPE

Apply STE rules to documentation, explanations, procedures, and code comments.

Do not change source code, identifiers, commands, paths, literals, API names,
UI labels, error messages, logs, quoted text, or required external terminology.

Treat necessary domain terms as technical nouns or technical verbs.
Use one technical term consistently for each item or concept.

VOCABULARY

* Use dictionary words only with their approved meanings and parts of speech.
* Use approved technical nouns and technical verbs.
* Use American English unless an official directive requires different spelling.
* Do not use unapproved slang, jargon, or phrasal verbs.
* Do not replace precise technical terms with less accurate words.

VERBS

* Use the infinitive, imperative, simple present, simple past, or simple future.
* Use a past participle as an adjective only.
* Use an "-ing" form only as an approved word, technical noun, or noun modifier.
* Use the active voice.
* In descriptive text, use passive voice only when the agent is unknown.

PROCEDURES

* Use an imperative verb for each instruction.
* Use no more than 20 words in each sentence.
* Give one instruction in each sentence.
* Combine instructions only when the actions occur at the same time.
* When the reader must know a condition first, put the condition first.

DESCRIPTIVE TEXT

* Use no more than 25 words in each sentence.
* Give one primary topic in each sentence.
* Give one topic in each paragraph.
* Start each paragraph with a topic sentence.
* Use no more than six sentences in each paragraph.

NOUNS AND SENTENCES

* Use no more than three words in a multi-word noun.
* If an official technical noun is longer, write it in full first.
* Then use an approved abbreviation or a clearly defined shorter form.
* Use hyphens only between words that form one directly related unit.
* Do not use contractions or semicolons.
* Do not omit necessary articles, verbs, or objects.
* Use a vertical list for complex text.
* Start each list item with an uppercase letter.

NOTES AND SAFETY

* Use NOTE only for information.
* Do not put instructions, requirements, or limits in a note.
* Use WARNING only for a risk of injury or death.
* Use CAUTION only for a risk of damage to an object.
* If a domain standard defines other labels, obey that standard.
* Start a safety instruction with a command or condition.
* Then state the risk or possible result.

OUTPUT CONTROL

Answer directly. Do not restate the request.
Do not add praise, generic introductions, repeated conclusions, or unnecessary notes.
Before delivery, silently check the applicable sentence lengths, terminology, verb forms, and prohibited forms.
Claim full STE compliance only after a validator checks the vocabulary against the Issue 9 dictionary.

COMPLIANCE TARGET

Aim for 80 percent pragmatic compliance, so output is in good shape by human standards.
Give priority to sentence length, active voice, and the prohibited forms.
Re-read these rules before you write or revise a documentation file.
```

The template also ships with this memory section:

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

NOTE: The superpowers skill set already works this way for larger
artifacts. It writes specs and plans into `docs/superpowers/specs/`, in
git. Component memory follows the same pattern, at a smaller size.

### Distribution

`sync-agents` renders the template and writes it to
every agent harness location. One file then governs all agents:

| Harness | Target |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| OpenAI Codex | `~/.codex/AGENTS.md` |
| Junie (JetBrains) | `~/.junie/AGENTS.md` |
| Cline | `~/.cline/rules/wagglebot.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` |
| GitHub Copilot CLI | `~/.copilot/copilot-instructions.md` |

Paths verified against vendor documentation on 2026-09-02.

Subagent directories: Claude Code `~/.claude/agents/`, Junie
`~/.junie/agents/`. Codex subagents are TOML, not Markdown, so Codex
has none. A harness with no known subagent directory is skipped, with
one log line.

Behavior: create missing directories. Diff before copy, and report
`synced` or `already ok`. Apply `chmod 600`. Print summary counts. Exit
non-zero on failure. The target list lives in one place: the script.

The sync is **non-destructive** (guards F22):

1. Write into a managed block. Markdown targets use comment markers
   (`<!-- wagglebot:begin -->` ... `<!-- wagglebot:end -->`). JSON
   targets have no comment syntax, so ownership is per entry: the tool
   records every key it wrote in a local state file,
   `~/.wagglebot/managed.json`, and it only ever rewrites those keys.
   Content outside the block, and every JSON key it did not write,
   stays untouched. The same rule covers the MCP config writer and
   `install-agents`.
2. Merge hook fragments per entry. Never replace a `hooks` key that
   contains entries this tool did not write.
3. Back up each target file before the first mutation, under
   `~/.wagglebot/backups/<timestamp>/`.
4. Provide `--dry-run` (show the diff, change nothing) and `--restore`
   (write the newest backup set back, every file in it; `--restore
   <path>` restores one target file from that set).

Secret distribution is **out of scope for this tool**. Tokens travel
through a secret manager or the company password manager, into the
gitignored `.env.credentials` file. The template sync never writes a
secret (guards F23).

## Harness Hooks

Base instructions lose salience in long agent sessions. A hook
re-injects the writing rules at edit time, at the moment they apply.
Hooks are harness-specific, so the mechanism mirrors the template
distribution: one fragment per harness, one sync script, per-harness
adapters.

- `templates/hooks/<harness>.json`, inside the package — the hook
  fragments.
  The seed fragment reminds the agent of the STE rules on each Markdown
  write.
- `sync-agents` merges each fragment into its harness config. The
  Claude Code adapter merges `hooks/claude-code.json` into
  `~/.claude/settings.json` with `jq` and preserves the other keys.
  This tooling owns only the hook entries that carry an wagglebot
  identifier. It never owns the complete `hooks` key, and it preserves
  every entry it did not write.
- Harnesses without hook support get the rules only through the base
  template. Add an adapter when a harness gains hook support.

NOTE: The base template is the portable layer and reaches every
harness. Hooks are a per-harness reinforcement, not a replacement.

## Component Memory Is A Local File (D29)

Not every memory belongs on a server. A fact about one repository
belongs **in** that repository:

```
.agents/memory.md
```

The directory name matters (D29). `.agents/` follows the emerging
dotagents convention, and it pairs with the `AGENTS.md` standard, so
an agent that never heard of wagglebot still recognizes it — even late
in a long session, when the base instructions have lost salience. The
rule: agents read and write `.agents/`, and wagglebot tooling reads
`.wagglebot/` (`catalog.yaml`, `public.md`).

Git already distributes that file to everyone who clones the
repository. A pull request reviews each change, and the history is
free. A server adds nothing. One deliberate divergence from the draft
convention: `memory.md` is **committed**, never gitignored, because
the pull-request review is the feature.

The shared store therefore holds only what crosses a repository
boundary:

| Scope | Where it lives |
|---|---|
| `component` | `.agents/memory.md`, in the repository |
| `system`, `domain`, `org` | The shared memory worker |

A search reads the local file first, then the three shared scopes.

This also makes the common case reviewable. A pull request that says
"the agent wants to remember this" beats a silent write into a vector
store.

NOTE: The superpowers skill set already works this way. It writes specs
and plans into `docs/superpowers/specs/`, in git. Component memory
follows the same pattern.

## Success Criteria

1. A clean machine runs `git clone <company repo>`, `yarn install`,
   and `yarn update:wagglebot`. The skills, the subagents, the base
   prompts, the MCP configs, and the shell block land in every
   harness. No service starts, and no credential is configured
   (D14, D34, D35).
2. `wagglebot update --help` explains what the command touches. A
   second run reports every item as already current.
3. **The pin bump upgrades everything.** The company merges a
   `package.json` change from `wagglebot 1.4.2` to `1.5.0`. The next
   `yarn update:wagglebot` on any workstation pulls, reinstalls the
   CLI at the new pin, and re-renders every managed block (D35).
4. An operator merges a registry change. The next `wagglebot update` on
   any workstation rewrites the managed block in each harness config,
   and content outside the block stays untouched.
5. `install-skills` installs every entry of `company/skills.list` and
   the team lists with the bundled `skills` CLI, on a clean machine. A
   second run reports every item as already installed.
6. A team merges a new entry into `company/agents.list`. The next
   `wagglebot update` (Phase 1) or hub refresh (Phase 2) installs that
   agent on a different workstation (D32).
7. An engineer asks an agent to write a custom agent. The
   `writing-a-custom-agent` skill asks where the agent belongs, before
   it writes any code (D33).
8. `sync-agents` writes one rendered template to every
   harness target. It creates missing directories. It reports the
   synced, already-ok, and failed counts.
9. Edit `AGENTS.base.md` and run `sync-agents` again. Every target then
   has the new content.
10. `sync-agents` merges the hook fragments into each supported harness
   config and preserves the other keys. A second run reports the hooks
   as already installed.
11. **Local component memory.** An agent records a repository fact in
    `.agents/memory.md` (D29). The file appears in `git status`, so
    a human reviews it. A later `memory_search` finds it without a
    server call.
12. `wagglebot update` on a machine with only Claude Code creates no
    directory for any other harness.
