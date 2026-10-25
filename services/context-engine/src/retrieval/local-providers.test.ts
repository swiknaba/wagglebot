import { expect, test } from "bun:test";
import type { LocalBrain } from "@wagglebot/local-brain";
import type { ContextRequest } from "../planning/query-plan";
import { createLocalProviders } from "./local-providers";

test("code content hashes change with snippet content without exposing its locator", async () => {
  let snippet = "return retryOnce();";
  const brain = {
    code: {
      exploreContext: async () => ({
        query: "retry",
        state: "ready",
        nodes: [
          {
            id: "stable-node",
            kind: "function",
            name: "retry",
            path: "src/worker.ts",
            startLine: 4,
            endLine: 6,
            snippet,
            stale: false,
          },
        ],
        edges: [],
        pendingFiles: [],
        observedAt: new Date().toISOString(),
        limitations: [],
      }),
    },
  } as unknown as LocalBrain;
  const provider = createLocalProviders(brain).code;
  if (!provider) throw new Error("code provider missing");
  const request: ContextRequest = { mode: "search", input: { projectPath: "/repo", query: "retry" } };
  const first = await provider(request, new AbortController().signal);
  snippet = "return retryWithBackoff();";
  const changed = await provider(request, new AbortController().signal);
  const firstCandidates = Array.isArray(first) ? first : first.candidates;
  const changedCandidates = Array.isArray(changed) ? changed : changed.candidates;
  expect(firstCandidates[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(changedCandidates[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(changedCandidates[0]?.contentHash).not.toBe(firstCandidates[0]?.contentHash);
  expect(changedCandidates[0]?.contentHash).not.toContain("src/worker.ts");
});
