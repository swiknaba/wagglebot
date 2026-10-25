import { expect, test } from "bun:test";
import { chunkKey, publicationKeys, sourceKey } from "./keys";

test("source and chunk keys are stable and unambiguous for delimiter-bearing identities", () => {
  expect(sourceKey("a\u0000b", "c", "domain:d")).not.toBe(sourceKey("a", "b\u0000c", "domain:d"));
  expect(sourceKey("repo", "path.md", "org")).toBe(sourceKey("repo", "path.md", "org"));
  expect(chunkKey("source", ["# A", "## B"], 1)).toMatch(/^[a-f0-9]{64}$/);
});

test("publication canonical identity separates chunk identity from original content hash", () => {
  const first = publicationKeys("source", "chunk", "exact body");
  const revised = publicationKeys("source", "chunk", "changed body");
  expect(first.identityKey).toMatch(/^publication:[a-f0-9]{64}$/);
  expect(revised.identityKey).toBe(first.identityKey);
  expect(revised.contentHash).not.toBe(first.contentHash);
  expect(revised.canonicalKey).toBe(`${revised.identityKey}:${revised.contentHash}`);
});
