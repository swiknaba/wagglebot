import { expect, test } from "bun:test";
import * as managedJson from "./managed-json";
import { hasJsonComments, mergeHooks, mergeManagedSection } from "./managed-json";

test("replaceJsonCategory clears all MCP entries and preserves unrelated settings", () => {
  const original = JSON.stringify({
    theme: "dark",
    hooks: { custom: [1] },
    mcpServers: { foreign: { command: "old" } },
  });
  const result = managedJson.replaceJsonCategory(original, "mcpServers", {});
  expect(JSON.parse(result.next)).toEqual({ theme: "dark", hooks: { custom: [1] }, mcpServers: {} });
  expect(result.changed).toBe(true);
  expect(managedJson.replaceJsonCategory(result.next, "mcpServers", {}).changed).toBe(false);
});

test("replaceJsonCategory replaces all hooks and preserves unrelated settings", () => {
  expect(typeof managedJson.replaceJsonCategory).toBe("function");
  const existing = JSON.stringify({ theme: "dark", model: "test", keybindings: ["ctrl+k"], hooks: { Old: [1] } });
  const hooks = { PostToolUse: [{ command: "new-hook" }] };
  const result = managedJson.replaceJsonCategory(existing, "hooks", hooks);
  expect(JSON.parse(result.next)).toEqual({ theme: "dark", model: "test", keybindings: ["ctrl+k"], hooks });
  expect(result.changed).toBe(true);
  expect(managedJson.replaceJsonCategory(result.next, "hooks", hooks).changed).toBe(false);
  expect(JSON.parse(managedJson.replaceJsonCategory("", "hooks", []).next)).toEqual({ hooks: [] });
  for (const invalid of ["{broken", "[]", "null", "1"]) {
    expect(() => managedJson.replaceJsonCategory(invalid, "hooks", hooks)).toThrow();
  }
});

test("mergeHooks recognizes direct commands, Copilot bash commands, and Kiro actions", () => {
  for (const [old, fresh] of [
    [{ command: "wagglebot:old" }, { command: "wagglebot:new" }],
    [
      { type: "command", bash: "wagglebot:old" },
      { type: "command", bash: "wagglebot:new" },
    ],
    [{ action: { command: "wagglebot:old" } }, { action: { command: "wagglebot:new" } }],
  ]) {
    const foreign = { name: "wagglebot:decoy", matcher: "wagglebot:decoy", command: "personal" };
    const result = mergeHooks(JSON.stringify({ hooks: { Event: [foreign, old] } }), { hooks: { Event: [fresh] } });
    expect(JSON.parse(result.next).hooks.Event).toEqual([foreign, fresh]);
    expect(mergeHooks(result.next, { hooks: { Event: [fresh] } }).changed).toBe(false);
  }
});

test("mergeHooks preserves foreign commands in a mixed nested hook group", () => {
  const personal = { type: "command", command: "personal" };
  const old = { type: "command", command: "wagglebot:old" };
  const fresh = { matcher: "Write", hooks: [{ type: "command", command: "wagglebot:new" }] };
  const existing = JSON.stringify({ hooks: { Event: [{ matcher: "Edit", hooks: [old, personal] }] } });
  const result = mergeHooks(existing, { hooks: { Event: [fresh] } });
  expect(JSON.parse(result.next).hooks.Event).toEqual([{ matcher: "Edit", hooks: [personal] }, fresh]);
  expect(mergeHooks(result.next, { hooks: { Event: [fresh] } }).changed).toBe(false);
});

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

test("mergeHooks does not misclassify a foreign entry whose matcher contains the marker", () => {
  const existing = JSON.stringify({
    hooks: {
      PostToolUse: [{ matcher: "wagglebot:decoy", hooks: [{ type: "command", command: "my-own-hook" }] }],
    },
  });
  const fragment = {
    hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "echo wagglebot:ste" }] }] },
  };
  const result = mergeHooks(existing, fragment);
  const doc = JSON.parse(result.next);
  expect(doc.hooks.PostToolUse).toHaveLength(2);
  expect(JSON.stringify(doc.hooks.PostToolUse)).toContain("my-own-hook");
});

test("mergeHooks replaces an owned entry where it stands and keeps foreign entries in place", () => {
  const owned = { hooks: [{ type: "command", command: "echo wagglebot:old" }] };
  const fresh = { hooks: [{ type: "command", command: "echo wagglebot:new" }] };
  const existing = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "a" }, owned, { matcher: "b" }] } });
  const { next } = mergeHooks(existing, { hooks: { PreToolUse: [fresh] } });
  expect(JSON.parse(next).hooks.PreToolUse).toEqual([{ matcher: "a" }, fresh, { matcher: "b" }]);
});

test("mergeHooks appends a new owned entry and drops one the fragment no longer carries", () => {
  const one = { hooks: [{ command: "wagglebot:one" }] };
  const two = { hooks: [{ command: "wagglebot:two" }] };
  const shrunk = mergeHooks(JSON.stringify({ hooks: { E: [one, { matcher: "x" }, two] } }), { hooks: { E: [one] } });
  expect(JSON.parse(shrunk.next).hooks.E).toEqual([one, { matcher: "x" }]);
  const grown = mergeHooks(JSON.stringify({ hooks: { E: [{ matcher: "x" }] } }), { hooks: { E: [one, two] } });
  expect(JSON.parse(grown.next).hooks.E).toEqual([{ matcher: "x" }, one, two]);
});

test("hasJsonComments finds a line comment and a block comment, and ignores strict JSON", () => {
  expect(hasJsonComments('{ // my note\n  "theme": "dark" }')).toBe(true);
  expect(hasJsonComments('{ /* my note */ "theme": "dark" }')).toBe(true);
  expect(hasJsonComments('{ "theme": "dark" }')).toBe(false);
});

test("hasJsonComments keeps a comment marker that a string literal carries", () => {
  // The stripper must not cut inside a value, or a commented file would read as corrupt.
  expect(hasJsonComments('{ /* note */ "url": "https://example.com//mcp" }')).toBe(true);
  expect(hasJsonComments('{ "quote": "he said \\" // not a comment" } // a real one')).toBe(true);
});

test("hasJsonComments reports false for corrupt JSON that also carries a comment", () => {
  expect(hasJsonComments('{ // my note\n  "theme": ')).toBe(false);
});

test("a removed entry named like an Object prototype member is still removed", () => {
  const existing = JSON.stringify({ mcpServers: { constructor: { url: "https://x" }, personal: { command: "c" } } });
  const { next } = mergeManagedSection(existing, "mcpServers", {}, ["constructor"]);
  const doc = JSON.parse(next);
  expect(Object.hasOwn(doc.mcpServers, "constructor")).toBe(false);
  expect(doc.mcpServers.personal).toEqual({ command: "c" });
});
