import { expect, test } from "bun:test";
import { RegistrySnapshotSchema } from "@wagglebot/contracts";
import { DiscoveryCache } from "./discovery/cache";
import { createIntrospection, Introspection, ToolCatalogCache } from "./introspection";

const registry = RegistrySnapshotSchema.parse({
  schemaVersion: 1,
  revision: `reg_${"a".repeat(64)}`,
  sourceRevision: "b".repeat(40),
  generatedAt: "2026-09-19T10:00:00.000Z",
  principal: { username: "alice" },
  proxies: [],
  toolCatalog: {
    version: 1,
    title: "Engineering tools",
    overview: "Use the narrowest reviewed tool family.",
    platform_context: ["Credentials remain on the workstation."],
    operating_principles: ["Inspect before mutation."],
    families: [
      {
        id: "github",
        title: "GitHub",
        namespace_patterns: ["github-*"],
        transport: "remote_http",
        tool_prefixes: ["repo"],
        summary: "Repository and pull request operations.",
        use_for: ["reviewing pull requests"],
        start_with: ["Search before execution."],
        avoid: ["using a mutation for read-only inspection"],
        domain_notes: ["Repository state is external input."],
        examples: ["Find a pull request before updating it."],
        routing_phrases: ["pull request"],
        routing_keywords: ["review", "repository"],
      },
      {
        id: "pagerduty",
        title: "PagerDuty",
        namespace_patterns: ["pagerduty"],
        summary: "Incident operations.",
        routing_keywords: ["incident"],
      },
    ],
  },
});

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

  expect(new Introspection({ cache, registry: () => registry }).listAvailableMcps()).toEqual({
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

test("renders reviewed catalog information only for mounted namespaces", () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("github-api", []);

  expect(new Introspection({ cache, registry: () => registry }).getToolCatalog()).toEqual({
    schemaVersion: 1,
    revision: `reg_${"a".repeat(64)}`,
    markdown:
      "# Engineering tools\n\nUse the narrowest reviewed tool family.\n\nPlatform context: Credentials remain on the workstation.\n\nOperating principles: Inspect before mutation.\n\n## GitHub\n\nRepository and pull request operations.\n\nNamespaces: github-api\n\nTransport: remote_http\n\nTool prefixes: repo\n\nUse for: reviewing pull requests\n\nStart with: Search before execution.\n\nAvoid: using a mutation for read-only inspection\n\nDomain notes: Repository state is external input.\n\nExamples: Find a pull request before updating it.",
  });
});

test("uses the configured local catalog with its own revision", async () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("local", []);
  const source = [
    "version: 1\ntitle: Local catalog\nfamilies:\n  - id: local\n    title: Local\n    namespace_patterns: [local]\n    summary: Local tools.\n",
    "version: 1\ntitle: Updated catalog\nfamilies:\n  - id: local\n    title: Local\n    namespace_patterns: [local]\n    summary: Updated tools.\n",
  ];
  const runtime = await createIntrospection({
    cache,
    registry: () => registry,
    config: { toolCatalogPath: "/catalog.yaml" },
    readFile: async () => source.shift() ?? "",
  });

  const result = runtime.introspection.getToolCatalog();
  expect(result.schemaVersion).toBe(1);
  expect(result.revision).toMatch(/^catalog_[a-f0-9]{64}$/);
  expect(result.markdown).toBe("# Local catalog\n\n## Local\n\nLocal tools.\n\nNamespaces: local");

  await runtime.refreshLocalCatalog();
  const updated = runtime.introspection.getToolCatalog();
  expect(updated.revision).not.toBe(result.revision);
  expect(updated.markdown).toBe("# Updated catalog\n\n## Local\n\nUpdated tools.\n\nNamespaces: local");
});

test("retains the last valid local catalog when a later file read is invalid", async () => {
  const reads = ["version: 1\ntitle: Local catalog\nfamilies: []\n", "version: invalid\ntitle: broken\nfamilies: []\n"];
  const catalog = new ToolCatalogCache({
    path: "/catalog.yaml",
    readFile: async () => reads.shift() ?? "",
  });

  await catalog.refresh();
  await expect(catalog.refresh()).rejects.toThrow();
  expect(catalog.current()).toEqual({
    version: 1,
    title: "Local catalog",
    platform_context: [],
    operating_principles: [],
    families: [],
  });
});

test("recommends mounted catalog families with documented deterministic scores", () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("github-api", []);
  cache.succeed("pagerduty", []);

  expect(new Introspection({ cache, registry: () => registry }).recommendToolFamilies("review a pull request")).toEqual(
    {
      schemaVersion: 1,
      families: [{ id: "github", title: "GitHub", score: 8, namespaces: ["github-api"] }],
    },
  );
});

test("usage guide identifies the CodeMode workflow and ready catalog families", () => {
  const cache = new DiscoveryCache({
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    retrySeconds: 30,
    refreshSeconds: 300,
    ttlSeconds: 30,
  });
  cache.succeed("github-api", []);

  expect(new Introspection({ cache, registry: () => registry }).getUsageGuide()).toEqual({
    schemaVersion: 1,
    markdown:
      "Use `search` to find a tool, `get_schema` to inspect its input, then `execute` with validated arguments.\n\nReady families:\n\n- GitHub (`github-api`)",
  });
});
