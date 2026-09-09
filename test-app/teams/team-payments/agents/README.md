# Team Subagents

Every Markdown file in this directory, except this README, installs as
a subagent on the workstation of each member of Group `team-payments`.
Wagglebot writes the file to every agent provider that supports
subagents, with the prefix `team-payments__`.

The file format is the same as in `company/agents/`: YAML front matter
with `name` and `description`, then the instructions.
