import { expect, test } from "bun:test";
import { hasJsonComments, mergeHooks, mergeManagedSection } from "./managed-json";

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
