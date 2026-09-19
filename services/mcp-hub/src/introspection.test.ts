import { expect, test } from "bun:test";
import { DiscoveryCache } from "./discovery/cache";
import { Introspection } from "./introspection";

test("lists only usable namespace status without raw tool schemas", () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("issues", [
    { name: "list", description: "list", inputSchema: { type: "object", secret: "must-not-leak" } },
  ]);
  cache.fail("offline", "upstream unavailable");

  expect(new Introspection(cache).listAvailableMcps()).toEqual({
    schemaVersion: 1,
    namespaces: [
      {
        namespace: "issues",
        status: "ready",
        toolCount: 1,
        lastSuccessAt: "2026-09-19T10:00:00.000Z",
        nextRetryAt: null,
      },
    ],
  });
});
