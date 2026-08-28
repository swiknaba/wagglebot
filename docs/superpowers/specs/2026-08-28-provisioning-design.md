# Workstation Provisioning

> Companion to the [agentframe design spec](2026-08-28-agentframe-design.md).
> One team shares one curated agent environment: the same skills, the
> same base instructions, on every workstation and in every agent
> harness. Ships under `provisioning/`.

## Curated Skills List

`provisioning/skills.list` — a versioned, comment-friendly list of skill
packages, one `owner/repo` per line. Seed content:

```
obra/superpowers
ayghri/i-have-adhd
```

## Skills Installer

`provisioning/bin/install-skills` — idempotent:

1. Install the `skills` npm CLI globally when missing
   (`npm install -g skills`).
2. `skills add <entry> -g -y` for every line in `skills.list`.
3. `skills update -g -y` to bring everything current.

Behavior: colored section output, installed/updated/ok/failed counters,
warn-and-continue when a dependency (npm, skills) is absent, non-zero
exit on failures.

## Agent Base Template + Distribution

`provisioning/templates/AGENTS.base.md` — the **shared agent base
template**. It contains harness-independent baseline instructions plus
an agentframe connection block (how to reach the hub, the
propose-not-write memory rule, coordination etiquette). Teams append
overlays; composition is plain concatenation
(`AGENTS.base.md` + `overlays/*.md` → rendered template). YAGNI: no
templating engine.

### Seed content for `AGENTS.base.md`

The template ships with this baseline section:

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
```

`provisioning/bin/sync-agents` — renders the template and writes it to
every agent harness location, so one file governs all agents:

| Harness | Target |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| OpenAI Codex | `~/.codex/AGENTS.md` |
| Junie (JetBrains) | `~/.junie/AGENTS.md`, `~/.junie/CLAUDE.md` |
| Cline | `~/.cline/rules/global.md`, `~/.cline/custom_instructions.md` |
| Universal standard | `~/.agents/AGENTS.md` |
| Gemini / Antigravity | `~/.gemini/config/GEMINI.md`, `~/.gemini/config/rules/global.md` |

Behavior: create missing directories, diff before copy (report `synced`
vs `already ok`), `chmod 600`, summary counts, non-zero exit on failure.
The target list lives in one place — the script.

## Local LLM Provisioning

No script needed — the facts inform the stack: `llama-server` is
OpenAI-compatible out of the box, models auto-download by `-hf` ref on
first run, and a small Qwen instruct model runs on CPU. The compose
stack applies this directly
(D2). The README documents model cache paths and how to point
`EXTRACTOR_API_BASE` at an existing local server (llama.cpp :8080,
Ollama :11434, LM Studio :1234) instead of the bundled container.

## Success Criteria

1. `provisioning/bin/install-skills` installs the `skills` CLI and every
   entry in `skills.list` on a clean machine, and a second run reports
   everything as already installed.
2. `provisioning/bin/sync-agents` writes one rendered template to every
   harness target, creates missing directories, and reports
   synced/already-ok/failed counts.
3. Editing `AGENTS.base.md` and re-running `sync-agents` updates every
   target to the new content.
