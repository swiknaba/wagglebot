import { expect, test } from "bun:test";
import { mergeHooks, mergeManagedSection } from "./managed-json";

test("writes owned entries, preserves foreign keys, removes stale owned entries", () => {
  const existing = JSON.stringify({ theme: "dark", mcpServers: { mine: { url: "http://x" }, old: { url: "y" } } });
  const r = mergeManagedSection(existing, "mcpServers", { example: { url: "https://e" } }, ["old"]);
  const doc = JSON.parse(r.next);
  expect(doc.theme).toBe("dark");
  expect(doc.mcpServers.mine).toEqual({ url: "http://x" }); // foreign, untouched
  expect(doc.mcpServers.old).toBeUndefined(); // stale owned, removed
  expect(doc.mcpServers.example).toEqual({ url: "https://e" });
  expect(r.ownedNow).toEqual(["example"]);
  expect(r.changed).toBe(true);
});

test("is idempotent on a second run", () => {
  const first = mergeManagedSection("", "mcpServers", { a: { url: "https://a" } }, []);
  const second = mergeManagedSection(first.next, "mcpServers", { a: { url: "https://a" } }, first.ownedNow);
  expect(second.changed).toBe(false);
});

test("mergeHooks replaces only wagglebot-marked entries and keeps foreign hooks", () => {
  const existing = JSON.stringify({
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-hook" }] }] },
  });
  const fragment = {
    hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "echo wagglebot:ste" }] }] },
  };
  const once = mergeHooks(existing, fragment);
  const doc = JSON.parse(once.next);
  expect(doc.hooks.PostToolUse).toHaveLength(2);
  expect(JSON.stringify(doc.hooks.PostToolUse[0])).toContain("my-own-hook");
  const twice = mergeHooks(once.next, fragment);
  expect(twice.changed).toBe(false);
});
