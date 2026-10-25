import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MemoryRecord, ProjectIdentity } from "@wagglebot/contracts";
import type { LocalBrain } from "@wagglebot/local-brain";
import { renderContext } from "../src/context/representation";
import { createContextEngine } from "../src/engine";
import type { SharedMemoryClient } from "../src/shared/client";

type Fixture = {
  id: string;
  mode: "search" | "explain";
  input: { query: string; path?: string; startLine?: number; endLine?: number };
  acceptableEvidenceIds: string[];
  exactIdentifierEvidenceIds: string[];
  requiredSources: Array<"local_memory" | "code" | "git" | "shared_memory">;
  requiredConflict: boolean;
};

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures.json", import.meta.url)), "utf8"),
) as Fixture[];
const observedAt = "2026-10-25T10:00:00.000Z";
const project: ProjectIdentity = {
  component: "evaluation",
  system: "billing",
  branch: "main",
  head: "a".repeat(40),
  workingTree: "clean",
  catalogState: "resolved",
};
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const recordFor = (fixture: Fixture): MemoryRecord => {
  const index = Number(fixture.id.slice("context-".length));
  const id = fixture.acceptableEvidenceIds
    .find((candidate) => candidate.startsWith("shared:"))
    ?.slice("shared:".length);
  if (!id) throw new Error("evaluation fixture has no shared evidence id");
  const codeIdentity = `source:src/${fixture.id}.ts:handle${index}`;
  return {
    id,
    schemaVersion: 1,
    scope: { kind: "system", name: "billing" },
    kind: "convention",
    title: `Shared convention ${fixture.id}`,
    content: `Reviewed shared evidence for ${fixture.id}.`,
    canonicalKey: `shared-${fixture.id}`,
    identityKey: fixture.requiredConflict ? codeIdentity : `shared:${fixture.id}`,
    contentHash: sha256(`shared:${fixture.id}`),
    confidence: "high",
    status: "active",
    wake: false,
    provenance: [
      { sourceType: "human", actor: "synthetic-fixture", repository: "example/billing", capturedAt: observedAt },
    ],
    createdAt: observedAt,
    updatedAt: observedAt,
  };
};

type ProviderCalls = { localMemory: number; code: number; git: number };

const makeBrain = (fixture: Fixture, calls: ProviderCalls, failCode = false): LocalBrain => {
  const suffix = fixture.id;
  const number = Number(suffix.slice("context-".length));
  const commit = number.toString().padStart(40, "0");
  const brain = {
    identify: async () => project,
    memory: {
      search: async () => {
        calls.localMemory += 1;
        return {
          hits: [
            {
              id: `memory-${suffix}`,
              path: `.agents/memory/conventions/${suffix}.md`,
              type: "Convention",
              title: `Local convention ${suffix}`,
              description: "",
              tags: ["synthetic"],
              headingPath: ["Convention"],
              content: `Local evidence for ${suffix}.`,
              startLine: 1,
              endLine: 3,
              contentHash: sha256(`local:${suffix}`),
              score: 1,
            },
          ],
          bundleHash: sha256(`bundle:${suffix}`),
        };
      },
    },
    code: {
      status: async () => ({ state: "ready", pendingFiles: [], observedAt }),
      exploreContext: async () => {
        calls.code += 1;
        if (failCode) throw new Error("synthetic provider failure");
        return {
          query: fixture.input.query,
          state: "ready",
          nodes: [
            {
              id: `symbol-${suffix}`,
              kind: "function",
              name: `handle${number}`,
              path: `src/${suffix}.ts`,
              startLine: 4,
              endLine: 8,
              snippet: `Current implementation for ${suffix}.`,
              stale: false,
            },
          ],
          edges: [],
          pendingFiles: [],
          observedAt,
          limitations: [],
        };
      },
      close: async () => {},
    },
    git: {
      status: async () => ({
        state: "ready",
        head: project.head,
        branch: project.branch,
        workingTree: "clean",
        shallow: false,
      }),
      history: async () => {
        calls.git += 1;
        return {
          commits: [{ commit, subject: `Decision history ${suffix}`, body: "", diffHunks: [], authorDate: observedAt }],
          limitations: [],
        };
      },
    },
    status: async () => ({
      project,
      memory: { path: ".agents/memory", state: "ready", observedAt },
      codeGraph: { state: "ready", pendingFiles: [], observedAt },
      git: { state: "ready", shallow: false },
      observedAt,
    }),
    close: async () => {},
  };
  return brain as unknown as LocalBrain;
};

const makeShared = (fixture: Fixture, queryCapture: unknown[], wakeCapture: unknown[]): SharedMemoryClient => ({
  search: async (input) => {
    queryCapture.push(input);
    return { schemaVersion: 1, records: [{ record: recordFor(fixture), score: 0.9 }] };
  },
  wake: async () => {
    wakeCapture.push({ purpose: "wake", limit: 3 });
    return {
      schemaVersion: 1,
      records: [{ record: { ...recordFor(fixture), wake: true, reviewAfter: "2026-12-31" }, score: 0.9 }],
    };
  },
  status: async () => ({ state: "ready", observedAt }),
});

export type EvaluationMetrics = {
  fixtureCount: number;
  evidenceRecallAt5: number;
  exactIdentifierRecallAt5: number;
  provenanceCompleteness: number;
  conflictPrecision: number;
  conflictRecall: number;
  sourceCoverage: number;
};

export async function runEvaluation(): Promise<EvaluationMetrics> {
  if (fixtures.length < 50) throw new Error("evaluation requires at least 50 fixtures");
  let retrieved = 0;
  let expected = 0;
  let exactRetrieved = 0;
  let exactExpected = 0;
  let itemsWithProvenance = 0;
  let itemCount = 0;
  let conflictExpected = 0;
  let conflictFound = 0;
  let conflictTruePositive = 0;
  let expectedSources = 0;
  let returnedSources = 0;

  for (const fixture of fixtures) {
    const queryRequests: unknown[] = [];
    const wakeRequests: unknown[] = [];
    const calls: ProviderCalls = { localMemory: 0, code: 0, git: 0 };
    const engine = createContextEngine(makeBrain(fixture, calls), {
      shared: makeShared(fixture, queryRequests, wakeRequests),
      now: () => new Date(observedAt),
    });
    const automatic = await engine.wake({ projectPath: "/repo" });
    if (
      automatic.items.length !== 0 ||
      automatic.estimatedTokens > 150 ||
      calls.localMemory !== 0 ||
      calls.code !== 0 ||
      calls.git !== 0 ||
      queryRequests.length !== 0 ||
      wakeRequests.length !== 0
    )
      throw new Error(`L0 contract failed for ${fixture.id}`);
    const orientation = await engine.wake({ projectPath: "/repo", level: 1 });
    const orientationShared = orientation.items.filter(({ source }) => source === "shared_memory");
    if (
      orientation.estimatedTokens > 500 ||
      orientationShared.length > 3 ||
      orientationShared.reduce((sum, item) => sum + Math.ceil(Array.from(item.excerpt).length / 3), 0) > 200 ||
      orientationShared.some(({ freshness, scope }) => freshness !== "unknown" || !scope)
    )
      throw new Error(`L1 contract failed for ${fixture.id}`);
    const taskContext = await engine.wake({ projectPath: "/repo", level: 2, task: fixture.input.query });
    if (
      taskContext.estimatedTokens > 1_500 ||
      taskContext.items.length > 6 ||
      taskContext.items.filter(({ source }) => source === "shared_memory").length > 3
    )
      throw new Error(`L2 contract failed for ${fixture.id}`);
    const l3 = await engine.wake({ projectPath: "/repo", level: 3, task: fixture.input.query });
    if (
      l3.estimatedTokens > 5_000 ||
      l3.items.length > 20 ||
      l3.items.filter(({ source }) => source === "shared_memory").length > 8
    )
      throw new Error(`L3 contract failed for ${fixture.id}`);
    const packet =
      fixture.mode === "explain"
        ? await engine.explain({
            projectPath: "/repo",
            query: fixture.input.query,
            path: fixture.input.path ?? `src/${fixture.id}.ts`,
            ...(fixture.input.startLine !== undefined ? { startLine: fixture.input.startLine } : {}),
            ...(fixture.input.endLine !== undefined ? { endLine: fixture.input.endLine } : {}),
          })
        : await engine.search({ projectPath: "/repo", query: fixture.input.query });
    const returnedIds = new Set(packet.items.slice(0, 5).map(({ id }) => id));
    expected += fixture.acceptableEvidenceIds.length;
    retrieved += fixture.acceptableEvidenceIds.filter((id) => returnedIds.has(id)).length;
    exactExpected += fixture.exactIdentifierEvidenceIds.length;
    exactRetrieved += fixture.exactIdentifierEvidenceIds.filter((id) => returnedIds.has(id)).length;
    itemCount += packet.items.length;
    itemsWithProvenance += packet.items.filter(({ provenance }) => provenance.length > 0).length;
    expectedSources += fixture.requiredSources.length;
    returnedSources += fixture.requiredSources.filter((source) =>
      packet.items.some((item) => item.source === source),
    ).length;
    if (
      packet.items.length > 6 ||
      packet.estimatedTokens > 1_500 ||
      packet.items.filter(({ source }) => source === "shared_memory").length > 3
    )
      throw new Error(`search budget contract failed for ${fixture.id}`);
    const requiredConflictCount = Number(fixture.requiredConflict);
    conflictExpected += requiredConflictCount;
    conflictFound += packet.conflicts.length;
    conflictTruePositive += Math.min(requiredConflictCount, packet.conflicts.length);
    const rendered = renderContext(packet, "markdown");
    for (const item of packet.items) {
      if (!rendered.text.includes(item.excerpt) || JSON.stringify(rendered.structuredContent).includes(item.excerpt))
        throw new Error(`single-representation contract failed for ${fixture.id}`);
    }
    const request = queryRequests[0] as Record<string, unknown> | undefined;
    if (!request || Object.keys(request).sort().join(",") !== "cascade,limit,purpose,query,schemaVersion")
      throw new Error(`shared request shape failed for ${fixture.id}`);
    if (JSON.stringify(request).includes(`src/${fixture.id}.ts`))
      throw new Error(`shared request path leak for ${fixture.id}`);
    for (const item of packet.items.filter(({ source }) => source !== "shared_memory")) {
      if (JSON.stringify(request).includes(item.excerpt)) throw new Error(`shared request leakage for ${fixture.id}`);
    }
    const repeated = await engine.search({ projectPath: "/repo", query: fixture.input.query, cursor: packet.cursor });
    if (repeated.items.length !== 0) throw new Error(`cursor repeated unchanged evidence for ${fixture.id}`);
    await engine.close();
  }

  const degradedCase = fixtures[1];
  if (!degradedCase) throw new Error("evaluation fixture is missing");
  const degradedCalls: ProviderCalls = { localMemory: 0, code: 0, git: 0 };
  const degradedEngine = createContextEngine(makeBrain(degradedCase, degradedCalls, true), {
    shared: makeShared(degradedCase, [], []),
    now: () => new Date(observedAt),
  });
  const degraded = await degradedEngine.search({ projectPath: "/repo", query: degradedCase.input.query });
  if (!degraded.degraded.some(({ provider }) => provider === "code") || degraded.items.length === 0)
    throw new Error("provider degradation did not preserve healthy evidence");
  await degradedEngine.close();

  return {
    fixtureCount: fixtures.length,
    evidenceRecallAt5: retrieved / expected,
    exactIdentifierRecallAt5: exactRetrieved / exactExpected,
    provenanceCompleteness: itemCount === 0 ? 1 : itemsWithProvenance / itemCount,
    conflictPrecision: conflictFound === 0 ? 1 : conflictTruePositive / conflictFound,
    conflictRecall: conflictExpected === 0 ? 1 : conflictTruePositive / conflictExpected,
    sourceCoverage: returnedSources / expectedSources,
  };
}

if (import.meta.main) {
  const metrics = await runEvaluation();
  process.stdout.write(`${JSON.stringify(metrics)}\n`);
}
