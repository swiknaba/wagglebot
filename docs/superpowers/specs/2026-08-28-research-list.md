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

**What we know.** Very little. Nobody on this project has read the
Flue documentation yet. This entry records the pointer, not an
assessment. Do not treat anything below as a description of Flue.

**Questions to answer:**

1. What does Flue actually do? Describe it in two sentences, from the
   documentation, not from the name.
2. What layer does it sit at? Is it an agent runtime, a harness, a
   prompt framework, or a build tool for agent definitions?
3. What does a "custom agent for one project" mean in Flue? What does
   an author write, and what does Flue generate or run?
4. Does it overlap the wagglebot scope, or sit above it? Wagglebot is
   deliberately **runtime-agnostic** (Goal 5). A tool that defines
   agents may fit above wagglebot, and consume its MCP hub and memory.
5. Would a Flue agent consume the wagglebot MCP hub as a normal MCP
   client? If yes, the integration cost may be zero.
6. What is its license, its release cadence, and its dependency
   surface? D13 requires a pinned version for anything we ship.
7. Does it assume a JavaScript project, or any project? The reference
   use came from the Astro ecosystem.

**The decision this feeds.** Wagglebot ships no agent runtime today,
and Goal 5 says any runtime connects over HTTP and MCP. Two outcomes
are possible:

| Outcome | Meaning |
|---|---|
| Flue sits above wagglebot | Nothing to build. Document the pattern, and add an example. |
| Flue duplicates a wagglebot layer | A real decision. Compare, and pick one. |

The first outcome is more likely, and it costs nothing. Confirm that
before any design work.

**Next step.** Read the documentation. Answer questions 1 to 4. Then
decide whether the remaining questions matter.
