import { expect, test } from "bun:test";
import type { ValidatedSourceSnapshot } from "./catalog";
import { composeRegistry } from "./compose";

const proxy = (namespace: string, endpoint: string) => ({ namespace, mode: "remote_http" as const, endpoint });
const source = (): ValidatedSourceSnapshot => ({
  sourceRevision: "a".repeat(40),
  generatedAt: "2026-09-13T00:00:00.000Z",
  catalog: {
    users: new Map([["alice", ["z-team", "a-team"]]]),
    groups: new Set(["a-team", "z-team"]),
    groupsFor: () => ["z-team", "a-team"],
  },
  company: [proxy("shared", "https://company.example/mcp"), proxy("company", "https://company.example/only")],
  teams: new Map([
    ["a-team", [proxy("shared", "https://a.example/mcp")]],
    ["z-team", [proxy("shared", "https://z.example/mcp"), proxy("z-only", "https://z.example/mcp")]],
  ]),
  toolCatalog: { version: 1, title: "Tools", platform_context: [], operating_principles: [], families: [] },
});

test("composes sorted team layers with complete-entry replacement", () => {
  const result = composeRegistry({ username: "alice" }, source());
  expect(result.proxies.map((item) => item.namespace)).toEqual(["company", "shared", "z-only"]);
  expect(result.proxies.find((item) => item.namespace === "shared")?.endpoint).toBe("https://z.example/mcp");
});

test("rejects an unregistered principal and is deterministic", () => {
  expect(() => composeRegistry({ username: "mallory" }, source())).toThrow(/registered/);
  expect(composeRegistry({ username: "alice" }, source())).toEqual(composeRegistry({ username: "alice" }, source()));
});
