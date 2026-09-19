import { expect, test } from "bun:test";
import { DiscoveryCache } from "./cache";

const tool = { name: "list_issues", description: "Lists issues", inputSchema: { type: "object" as const } };

test("retains warm tools and schedules a retry when a later discovery fails", () => {
  let now = new Date("2026-09-19T10:00:00.000Z");
  const cache = new DiscoveryCache({ now: () => now, retrySeconds: 30, refreshSeconds: 300, ttlSeconds: 30 });

  cache.begin("github");
  cache.succeed("github", [tool]);
  now = new Date("2026-09-19T10:00:10.000Z");
  cache.begin("github");
  cache.fail("github", "upstream unavailable");

  expect(cache.state("github")).toEqual({
    status: "error",
    toolCount: 1,
    tools: [tool],
    lastAttemptAt: "2026-09-19T10:00:10.000Z",
    lastSuccessAt: "2026-09-19T10:00:00.000Z",
    lastDiscoveryError: "upstream unavailable",
    consecutiveFailures: 1,
    nextRetryAt: "2026-09-19T10:00:40.000Z",
  });
});
