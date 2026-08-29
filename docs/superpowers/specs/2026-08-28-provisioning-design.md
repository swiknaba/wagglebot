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
```

An unpinned entry is rejected. An unpinned entry would execute whatever
the repository publishes next, on every workstation (P31, D13).

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
2. `provisioning/bin/sync-agents` writes one rendered template to every
   harness target. It creates missing directories. It reports the
   synced, already-ok, and failed counts.
3. Edit `AGENTS.base.md` and run `sync-agents` again. Every target then
   has the new content.
4. `sync-agents` merges the hook fragments into each supported harness
   config and preserves the other keys. A second run reports the hooks
   as already installed.
