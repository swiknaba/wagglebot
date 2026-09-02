# Shared Subagents

Every Markdown file in this directory, except this README, installs as
a subagent on every workstation. The installed name gets the prefix
`company__`. Claude Code reads it from `~/.claude/agents/`. Harnesses
without subagent support skip it with one log line.

Use this directory for specialists the whole company invokes on demand,
for example a security reviewer or a migration planner. A subagent that
serves one repository belongs in that repository instead, in
`.agents/subagents/`. A subagent maintained in another git repository
goes in `agents.base.list`.

A subagent file starts with YAML front matter:

    ---
    name: security-reviewer
    description: Reviews a change for security defects. Use before merge.
    ---

    Instructions for the subagent follow here.
