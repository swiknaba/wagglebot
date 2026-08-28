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
