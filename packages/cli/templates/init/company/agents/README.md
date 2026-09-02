# Shared Subagents

Every Markdown file in this directory, except this README, installs as
a subagent on every workstation. Wagglebot knows where each agent
provider reads its subagents and writes the file to every one of those
locations, with the prefix `company__`. You never have to know or care
where a provider stores its files. A provider with no subagent support
is skipped with one log line, and gains support through a wagglebot
upgrade, not through a change in this repository.

Use this directory for specialists the whole company invokes on demand,
for example a security reviewer or a migration planner. A subagent for
one team is committed to `teams/<team>/agents/` instead. A subagent
that serves one repository is committed to `.agents/subagents/` in that
repository instead. A subagent maintained in another git repository is
listed in `company/agents.list`.

A subagent file starts with YAML front matter:

    ---
    name: security-reviewer
    description: Reviews a change for security defects. Use before merge.
    ---

    Instructions for the subagent follow here.
