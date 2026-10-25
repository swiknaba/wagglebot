# Context Engine evaluation

`fixtures.json` contains 50 synthetic questions with expected evidence IDs,
source coverage, exact code identifiers, and one explicit conflict. The
runner passes each question through `createContextEngine` with deterministic
local and shared provider fixtures. It checks evidence recall at five,
provenance, conflict precision/recall, provider boundaries, cursors, response
representations, graceful degradation, and L0–L3/search limits.

The runner measures orchestration and contract behavior. Its synthetic
providers do not measure semantic relevance over a production repository.

Run it with:

```sh
CODEGRAPH_TELEMETRY=0 bun test services/context-engine/evaluation/run.test.ts
```
