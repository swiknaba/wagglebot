import { expect, test } from "bun:test";
import { ContextCursorCache } from "./cursor";

test("cursor suppresses unchanged IDs, redelivers changed hashes, and resets unknown handles", () => {
  let now = 1;
  const cache = new ContextCursorCache(() => now);
  const first = cache.prepare(undefined, [{ id: "a", contentHash: "1" }]);
  expect(first.candidates).toHaveLength(1);
  cache.commit(first, first.candidates);
  const second = cache.prepare(first.cursor, [
    { id: "a", contentHash: "1" },
    { id: "b", contentHash: "2" },
  ]);
  expect(second.omitted).toBe(1);
  expect(second.candidates.map(({ id }) => id)).toEqual(["b"]);
  cache.commit(second, second.candidates);
  const changed = cache.prepare(second.cursor, [{ id: "a", contentHash: "3" }]);
  expect(changed.candidates.map(({ contentHash }) => contentHash)).toEqual(["3"]);
  cache.commit(changed, changed.candidates);
  expect(cache.prepare("ctx_unknown", []).reset).toBe(true);
  now += 4 * 60 * 60 * 1_000 + 1;
  expect(cache.prepare(first.cursor, []).reset).toBe(true);
});

test("cursor cache stays within its process-wide bound", () => {
  const cache = new ContextCursorCache(() => 1);
  for (let index = 0; index < 129; index += 1) {
    const cursor = cache.prepare(undefined, []);
    cache.commit(cursor, []);
  }
  expect(cache.size).toBe(128);
});
