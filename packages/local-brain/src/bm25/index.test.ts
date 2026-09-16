import { expect, test } from "bun:test";
import { Bm25Index } from "./index";

test("an exact identifier ranks its section first", () => {
  const index = new Bm25Index(
    [
      { id: "architecture", text: "TokenService owns refresh token rotation" },
      { id: "testing", text: "Run integration tests with Bun" },
    ],
    (item) => item.text,
    (item) => item.id,
  );

  expect(index.search("TokenService", 2)[0]?.item.id).toBe("architecture");
});

test("returns no results for an empty corpus or query", () => {
  const empty = new Bm25Index<{ id: string; text: string }>(
    [],
    (item) => item.text,
    (item) => item.id,
  );
  const blankDocument = new Bm25Index(
    [{ id: "empty", text: "" }],
    (item) => item.text,
    (item) => item.id,
  );

  expect(empty.search("TokenService", 1)).toEqual([]);
  expect(blankDocument.search("", 1)).toEqual([]);
});

test("keeps equal scores in input order", () => {
  const index = new Bm25Index(
    [
      { id: "first", text: "rotate token" },
      { id: "second", text: "rotate token" },
    ],
    (item) => item.text,
    (item) => item.id,
  );

  expect(index.search("rotate", 2).map((result) => result.item.id)).toEqual(["first", "second"]);
});

test("returns no results for invalid limits and no more than the requested limit", () => {
  const index = new Bm25Index(
    [
      { id: "first", text: "rotate token" },
      { id: "second", text: "rotate token" },
    ],
    (item) => item.text,
    (item) => item.id,
  );

  expect(index.search("rotate", 0)).toEqual([]);
  expect(index.search("rotate", -1)).toEqual([]);
  expect(index.search("rotate", 1).map((result) => result.item.id)).toEqual(["first"]);
  expect(index.search("rotate", 10).map((result) => result.item.id)).toEqual(["first", "second"]);
});
