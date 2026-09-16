import { expect, test } from "bun:test";

import { parseBlameCommits, parseLog } from "./parse";

test("parses multiline commit bodies with NUL record separators", () => {
  const commits = parseLog(
    "abc\x00subject\x00line one\nline two\x002026-09-11T10:00:00Z\x00A Name\x00src/token.ts\x00\u001e",
  );

  expect(commits).toEqual([
    {
      commit: "abc",
      subject: "subject",
      body: "line one\nline two",
      authorDate: "2026-09-11T10:00:00Z",
      authors: ["A Name"],
      changedPaths: ["src/token.ts"],
    },
  ]);
});

test("ignores an incomplete trailing record", () => {
  expect(parseLog("abc\0subject\0body")).toEqual([]);
});

test("collects unique commits from porcelain blame headers", () => {
  expect(parseBlameCommits("abc123def456abc123def456abc123def456abc1 1 1 1\nauthor Fixture\n")).toEqual([
    "abc123def456abc123def456abc123def456abc1",
  ]);
});
