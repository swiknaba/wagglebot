# Research List

> Ideas that need study before a decision. Each entry states what we
> know, what we do not know, and the questions that would settle it.
>
> An entry leaves this list in one of three ways: into a decision, into
> the [descoped ideas](2026-08-28-descoped-ideas.md), or into the bin.

## R1. Flue, For Building Project-Specific Agents

**Source:** `https://github.com/withastro/flue`

**Why it is here.** The reference codebase used Flue to build custom
agents for one company. That is a job wagglebot does not do today.

**Status: researched. It sits above wagglebot.**

### What Flue is

Flue calls itself "the sandbox agent framework" and "a programmable
TypeScript harness." It is an **agent runtime and harness**, so it
occupies the layer that wagglebot deliberately leaves empty (Goal 5).

An author writes a TypeScript function for each agent, for example
`agents/triage.ts`. The function composes behavior through hooks:
`useModel()`, `useSandbox()`, `useSkill()`, `useTool()`, and
`usePersistentState()`. Skills are Markdown files, and tools are
TypeScript modules. Flue runs the agent, and records each session in a
durable stream that survives a crash.

| Property | Value |
|---|---|
| Layer | Agent runtime and harness |
| Language | TypeScript, on Node.js |
| Core package | `@flue/runtime` |
| MCP | **Yes, as a client.** "Connect agents to thousands of tools through the open Model Context Protocol." |
| License | Apache-2.0 |
| Stability | No version or status warning found. Treat the version as unpinned until checked (D13). |

### How it fits

**A Flue agent is an MCP client, so it points at the local hub like any
other runtime.** The integration cost is therefore near zero, and
Goal 5 already permits it. Nothing needs a design change.

Three points of contact deserve a note:

1. **Skills overlap, and that is useful, not a conflict.** Flue loads
   Markdown skills through `useSkill()`. Wagglebot provisioning already
   installs a curated, pinned skill set (`skills.list`). One curated
   set can feed both an interactive harness and a Flue agent. Check
   whether the file formats match before promising that.
2. **`usePersistentState` is not team memory.** It holds the state of
   one agent across a crash. Wagglebot memory is shared between people
   and searchable. The two solve different problems, and neither
   replaces the other.
3. **Durable execution answers the descoped feature.** The
   Sentry-to-pull-request flow needed an agent that runs unattended and
   survives a crash. That is exactly what Flue provides. If that
   feature ever returns, **run it on Flue instead of building a task
   board.** See the [descoped ideas](2026-08-28-descoped-ideas.md).

### Remaining questions

1. Do the Flue skill format and the `skills.list` packages match, or
   would a team maintain two sets?
2. What version pins cleanly for D13?

**Next step.** None required. Wagglebot needs no change. Answer the two
questions above before documenting a Flue example.
