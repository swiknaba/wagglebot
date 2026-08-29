# Workstation Provisioning

> Companion to the [wagglebot design spec](2026-08-28-wagglebot-design.md).
> One team shares one curated agent environment: the same skills and the
> same base instructions, on every workstation and in every agent
> harness. This tooling ships under `provisioning/`.

## Curated Skills List

`provisioning/skills.list` is a versioned list of skill packages. The
format is one **pinned** entry per line: `owner/repo@<ref>`, where the
ref is a tag or a commit hash. Comments are allowed. Seed content:

```
obra/superpowers@<pinned-ref>
ayghri/i-have-adhd@<pinned-ref>
wagglebot/skills@<pinned-ref>        # first-party, D33
```

An unpinned entry is rejected. An unpinned entry would execute whatever
the repository publishes next, on every workstation (P31, D13).

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

`provisioning/bin/install-skills` is idempotent and reproducible:

1. Install the `skills` npm CLI at the **pinned version** from
   `provisioning/versions.env` when it is missing or differs
   (`npm install -g skills@<version>`).
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
| **Component agent** — useful for one repository | `.wagglebot/agents/` in that repository | Git. Nothing to do. |
| **Shared agent** — useful for a team or the organization | A repository of its own | The list below |

A component agent needs no wagglebot feature. Git already gives it to
everyone who clones the repository, a pull request reviews each change,
and the history is free. This mirrors component memory (D29).

### The lists

Two layers, which compose the same way the registry does:

```
central/agents.base.list          # every engineer
central/agents.team.<team>.list   # one team
```

One entry per line, `owner/repo`, with an optional `@<ref>`. Comments
are allowed.

Wagglebot ships the mechanism and an **empty** list with commented
examples. The content belongs to one installation, so this repository
never carries it. That matches `registry.yaml`.

### Distribution is automatic (D32)

The hub already fetches the registry from the shared layer on refresh.
It carries the agent list on the same request, and **installs or
updates each agent without asking**.

An engineer therefore does nothing. A team publishes an agent, and it
appears on every workstation.

`install-agents` still exists, for a first setup and for a manual
refresh. It is not the normal path.

### Why automatic here, and pinned for skills

The two lists point at different things:

| List | Points at | Published by |
|---|---|---|
| `skills.list` | `obra/superpowers` and similar | **Third parties** |
| `agents.*.list` | Your own repositories | **You** |

A pin on `skills.list` protects you from the next release of somebody
else's repository. A pin on your own agents would protect you from your
own colleagues, which contradicts D15. The organization is trusted, and
a pull request already reviews every change.

Two rules still apply, and both are cheap:

1. **An entry outside your organization must carry a pin.** That entry
   is a third party again, so the `skills.list` rule returns.
2. **A team may pin its own entry when it wants a stable release.** The
   pin is available, and it is never required.

### Contribution

A team contributes an agent in three steps:

1. Write the agent in its own repository.
2. Open a pull request that adds the entry to `agents.base.list`, or to
   a team list.
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
   | This repository | `.wagglebot/agents/` in this repository |
   | The team or the organization | Its own repository, plus a pull request on `agents.base.list` |

3. **The consequences of each answer**, so the engineer chooses well. A
   local agent needs no review from another team, and it disappears
   when somebody clones a different repository. A shared agent reaches
   every workstation, so a second person reviews it.

The skill never chooses for the engineer. It asks, and it explains the
trade.

## Agent Base Template + Distribution

`provisioning/templates/AGENTS.base.md` is the **shared agent base
template**. It contains harness-independent instructions plus an
wagglebot connection block. The connection block covers three topics:
how to reach the hub, the propose-not-write memory rule, and
coordination etiquette. Teams append overlays. Composition is plain
concatenation: `AGENTS.base.md` + `overlays/*.md` → the rendered
template. YAGNI: no templating engine.

The base template carries three sections: a delegation policy, a
writing baseline, and a memory policy. All three are portable across
harnesses and across teams.

The memory section is **required**, not optional. The agent extracts its
own memory (D24), so the rules must reach the agent. A server policy
file cannot do that job.

Workstation-specific content stays out of the base template. Version
managers, shell paths, and machine setup differ per person and per
team. Put that content in an overlay.

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

You decide what to remember. No model on the server repeats this work,
so a fact you skip is lost, and a fact you invent is believed.

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
* A secret. The server rejects one, but never send one.

Write few facts. A large memory is a haystack.

WHERE TO WRITE

Four scopes exist. Pick the smallest one that fits.

| Scope | Content | How to write |
|---|---|---|
| `component` | A fact about this one repository | Edit `.wagglebot/memory.md` |
| `system` | A fact about the whole project | Propose, then ask your engineer |
| `domain` | A convention across projects | A human publishes it |
| `org` | A company-wide interface | A human publishes it |

Default to `component`. A file in the repository travels with the code,
a pull request reviews it, and git keeps the history.

Propose `system` only for a fact that a different repository needs.
Then ask your engineer in the session, and accept the answer. Never
promote silently. Never write to `domain` or `org`.

BEFORE YOU WRITE

1. Search memory first.
2. If the fact exists, update it. Do not add a duplicate.
3. If the fact contradicts an existing one, say so to your engineer.

WHEN TO WRITE

Write at the end of a session, and after you learn something that cost
you time. Do not write during exploration.

WHEN YOUR ENGINEER TELLS YOU TO REMEMBER SOMETHING

Use the `remember` tool, and give the scope they named.

* Do not judge the importance. They asked, so write it.
* Do not ask to promote the scope. They already chose it.
* Ask only when they named no scope. Suggest the smallest one that fits.

Use `forget` when they tell you a fact is wrong.
```

NOTE: The superpowers skill set already works this way for larger
artifacts. It writes specs and plans into `docs/superpowers/specs/`, in
git. Component memory follows the same pattern, at a smaller size.

### Distribution

`provisioning/bin/sync-agents` renders the template and writes it to
every agent harness location. One file then governs all agents:

| Harness | Target |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| OpenAI Codex | `~/.codex/AGENTS.md` |
| Junie (JetBrains) | `~/.junie/AGENTS.md`, `~/.junie/CLAUDE.md` |
| Cline | `~/.cline/rules/global.md`, `~/.cline/custom_instructions.md` |
| Universal standard | `~/.agents/AGENTS.md` |
| Gemini / Antigravity | `~/.gemini/config/GEMINI.md`, `~/.gemini/config/rules/global.md` |

Behavior: create missing directories. Diff before copy, and report
`synced` or `already ok`. Apply `chmod 600`. Print summary counts. Exit
non-zero on failure. The target list lives in one place: the script.

The sync is **non-destructive** (guards F22):

1. Write into a managed block
   (`<!-- wagglebot:begin -->` ... `<!-- wagglebot:end -->`) where the
   harness format permits. Content outside the block stays untouched.
2. Merge hook fragments per entry. Never replace a `hooks` key that
   contains entries this tool did not write.
3. Back up each target file before the first mutation, under
   `~/.wagglebot/backups/<timestamp>/`.
4. Provide `--dry-run` (show the diff, change nothing) and `--restore`
   (write the newest backup back).

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

- `provisioning/templates/hooks/<harness>.json` — the hook fragments.
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

## Local LLM Provisioning

Local LLM provisioning needs no script. Three facts shape the stack. The
`llama-server` API is OpenAI-compatible out of the box. Models download
automatically by `-hf` reference on the first run. A small Qwen instruct
model runs on a CPU. The compose stack applies these facts directly
(D2). The README documents the model cache paths. It also documents how
to point `EXTRACTOR_API_BASE` at an existing local server (llama.cpp
:8080, Ollama :11434, LM Studio :1234) instead of the bundled container.

## Success Criteria

1. `provisioning/bin/install-skills` installs the `skills` CLI and every
   entry in `skills.list` on a clean machine. A second run reports every
   item as already installed.
2. A team merges a new entry into `agents.base.list`. The next hub
   refresh installs that agent on a different workstation, with no
   command from its engineer (D32).
3. An engineer asks an agent to write a custom agent. The
   `writing-a-custom-agent` skill asks where the agent belongs, before
   it writes any code (D33).
4. `provisioning/bin/sync-agents` writes one rendered template to every
   harness target. It creates missing directories. It reports the
   synced, already-ok, and failed counts.
5. Edit `AGENTS.base.md` and run `sync-agents` again. Every target then
   has the new content.
6. `sync-agents` merges the hook fragments into each supported harness
   config and preserves the other keys. A second run reports the hooks
   as already installed.
