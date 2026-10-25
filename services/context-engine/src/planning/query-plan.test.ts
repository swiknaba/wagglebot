import { expect, test } from "bun:test";
import { createQueryPlan } from "./query-plan";

test("automatic L0 never selects providers", () => {
  expect(createQueryPlan({ mode: "wake", input: { projectPath: "/repo" } }).providers).toEqual([]);
});

test("L1 uses a small local orientation plan and only the shared wake operation", () => {
  const plan = createQueryPlan({ mode: "wake", input: { projectPath: "/repo", level: 1 } });
  expect(plan.providers).toEqual(["local_memory", "code", "git", "shared_memory"]);
  expect(plan.sharedPurpose).toBe("wake");
  expect(plan.aggregateDeadlineMs).toBe(750);
  expect(plan.candidateCaps).toMatchObject({ local_memory: 2, git: 3, shared_memory: 3 });
});

for (const [level, sharedCap] of [
  [2, 3],
  [3, 8],
] as const) {
  test(`L${level} wake with a task queries shared memory`, () => {
    const plan = createQueryPlan({ mode: "wake", input: { projectPath: "/repo", level, task: "review retries" } });
    expect(plan.providers).toEqual(["local_memory", "code", "git", "shared_memory"]);
    expect(plan.sharedPurpose).toBe("query");
    expect(plan.candidateCaps.shared_memory).toBe(sharedCap);
  });
}

test("search honors source selection and uses the query endpoint", () => {
  const plan = createQueryPlan({ mode: "search", input: { projectPath: "/repo", query: "auth", sources: ["git"] } });
  expect(plan.providers).toEqual(["git"]);
  expect(plan.sharedPurpose).toBeUndefined();
});
