# Descoped Ideas

> Ideas we designed, then removed from the MVP. Each entry records what
> the idea was, why we removed it, and what would bring it back.
>
> Nothing here is rejected. Each idea waits for evidence.

## Event-Triggered Agent Flows

### The idea

An external event starts an agent, and the agent does real work.

```
Sentry sees an error
   ↓
Wagglebot receives it
   ↓
Wagglebot makes a job:  "fix this error in system payments-platform"
   ↓
One agent takes the job
   ↓
The agent reads the code, writes a fix, opens a pull request
   ↓
A human reviews the pull request
```

Other triggers we considered:

* A Slack mention starts an agent that answers in the thread.
* A GitHub issue comment starts an agent that proposes a patch.
* A generic webhook starts any flow.

The design put wagglebot in one role only: **deliver the event to an
agent.** The agent reads the code, writes the fix, and opens the pull
request. Wagglebot never touches the code. One rule kept the risk low:
the agent opens a pull request and stops. It never merges, and it never
deploys.

### Why we removed it

**1. A local agent already does this, and does it better.**

Connect a Sentry MCP server. Tell your agent: "fix the top error." You
watch the work, you steer it, and you stop it. That path needs no
framework.

**2. The feature only pays off when nobody is watching.**

The event delivery earns its place for **unattended** agents: a machine
that runs while you sleep. That is a working habit, and we do not have
it yet. Building the delivery system first builds for a habit that may
never form.

**3. The cost lands on the simplest part of the system.**

Unattended agents create a race. Three agents hear one event, so three
agents open three pull requests for one bug. Preventing that needs a
task board, a claim, a lease, a heartbeat, and a fencing counter. That
machinery was the most complex part of the MVP, and it existed only for
this feature.

### What would bring it back

Run the experiment without the framework. Point a local agent at a
Sentry MCP server for two weeks. Then answer one question:

**Did you wish it ran overnight?**

A yes means the delivery system is worth building. A no means we saved
the work.

### What we would build, if the answer is yes

**First, check whether we build anything at all.** An unattended agent
needs durable execution: it must survive a crash and resume. That is
what an agent runtime such as Flue already provides
([research list R1](2026-08-28-research-list.md)). Running the flow on
an existing runtime may remove the need for a task board completely.

If a delivery system is still needed, keep it a delivery system, never
a workflow engine.

```yaml
# channels.yaml
routes:
  - source: sentry
    match: { project: payments-api }
    system: payments-platform
    prompt: "Fix this error. Open a pull request. Do not deploy."
```

A new trigger is a new block. That is the whole plug-in system.

We considered a workflow tool such as n8n, and rejected it. A workflow
tool adds a server, a database, and a user interface. Three routes in a
configuration file do not need that.

The claim machinery comes back with the feature, because the race comes
back with it:

| Term | Plain meaning |
|---|---|
| Task board | The list of jobs nobody has taken |
| Claim | One agent takes a job, so the others skip it |
| Lease | The claim expires, so a sleeping laptop never blocks a job |
| Heartbeat | The agent says "still working" every 30 seconds |
| Fencing counter | A number that rises on each claim, so a late agent cannot finish a job somebody else already did |

## Component Memory In The Vector Store

### The idea

Every memory scope lived in the shared vector store, including facts
about one repository.

### Why we removed it

Git already distributes a file inside one repository. Everyone who
clones the repository gets the file. A pull request reviews each
change, and the history is free.

A server should hold only what git cannot: facts that cross a
repository boundary. Those are the `system`, `domain`, and `org`
scopes.

Local files also make the common case reviewable. A pull request that
says "the agent wants to remember this" beats a silent write into a
vector store.

### The replacement

Component memory is a Markdown file in the repository,
`.wagglebot/memory.md` (D29). The shared store keeps the three scopes
that cross a boundary.
