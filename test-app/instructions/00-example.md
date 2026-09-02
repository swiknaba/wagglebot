## Company Instructions Example

Every Markdown file in this directory is appended to the shared base
prompt that wagglebot ships. The result is written to the global
instructions file of each agent harness on every workstation, for
example `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`.

Add one file per topic. Files are appended in filename order, so a
numeric prefix controls the order. Put company and team conventions
here. Never edit the base prompt itself: a wagglebot upgrade replaces it.
