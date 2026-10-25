import { expect, test } from "bun:test";
import { runEvaluation } from "./run";

test("50 synthetic questions meet the deterministic retrieval and response thresholds", async () => {
  const metrics = await runEvaluation();
  expect(metrics.fixtureCount).toBeGreaterThanOrEqual(50);
  expect(metrics.evidenceRecallAt5).toBeGreaterThanOrEqual(0.85);
  expect(metrics.exactIdentifierRecallAt5).toBe(1);
  expect(metrics.provenanceCompleteness).toBe(1);
  expect(metrics.conflictPrecision).toBe(1);
  expect(metrics.conflictRecall).toBe(1);
  expect(metrics.sourceCoverage).toBe(1);
});
