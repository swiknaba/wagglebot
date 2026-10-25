import { expect, test } from "bun:test";
import type { ContextRequest, QueryPlan } from "../planning/query-plan";
import { runRetrieval } from "./run";
import type { RetrievalCandidate } from "./types";

const request: ContextRequest = { mode: "search", input: { projectPath: "/repo", query: "auth" } };
const candidate: RetrievalCandidate = {
  id: "git:a",
  source: "git",
  kind: "commit",
  title: "Rotate auth tokens",
  content: "Rotate auth tokens",
  contentHash: "a".repeat(40),
  exactMatch: false,
  provenance: [{ kind: "git", commit: "a".repeat(40) }],
  freshness: "historical",
  authorityTier: 70,
  channels: [{ name: "git_history", rank: 1, weight: 1.1 }],
};

test("provider deadlines degrade independently while completed provider results survive", async () => {
  const plan: QueryPlan = {
    providers: ["local_memory", "git"],
    providerDeadlinesMs: { local_memory: 5, git: 100 },
    candidateCaps: { local_memory: 10, git: 10 },
    aggregateDeadlineMs: 80,
  };
  const result = await runRetrieval(plan, request, {
    local_memory: async () => new Promise<RetrievalCandidate[]>((resolve) => setTimeout(() => resolve([]), 40)),
    git: async () => [candidate],
  });
  expect(result.candidates.map(({ id }) => id)).toEqual(["git:a"]);
  expect(result.degraded).toEqual([{ provider: "local_memory", code: "timeout", elapsedMs: expect.any(Number) }]);
});

test("a healthy provider with no matches is a successful result", async () => {
  const result = await runRetrieval(
    { providers: ["git"], providerDeadlinesMs: { git: 100 }, candidateCaps: { git: 10 }, aggregateDeadlineMs: 200 },
    request,
    { git: async () => [] },
  );
  expect(result.candidates).toEqual([]);
  expect(result.degraded).toEqual([]);
});

test("caller cancellation stops outstanding retrieval", async () => {
  const controller = new AbortController();
  const task = runRetrieval(
    { providers: ["git"], providerDeadlinesMs: { git: 1_000 }, candidateCaps: { git: 10 }, aggregateDeadlineMs: 2_000 },
    request,
    {
      git: async (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    },
    Date.now,
    controller.signal,
  );
  controller.abort(new DOMException("stop", "AbortError"));
  await expect(task).rejects.toThrow();
});

test("a pre-aborted caller signal prevents all provider calls", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("stop", "AbortError"));
  let calls = 0;
  const task = runRetrieval(
    { providers: ["git"], providerDeadlinesMs: { git: 1_000 }, candidateCaps: { git: 10 }, aggregateDeadlineMs: 2_000 },
    request,
    {
      git: async () => {
        calls += 1;
        return [candidate];
      },
    },
    Date.now,
    controller.signal,
  );
  await expect(task).rejects.toThrow();
  expect(calls).toBe(0);
});
