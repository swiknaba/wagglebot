import { expect, test } from "bun:test";
import { parseList, replaceListLine, VERSION_TAG } from "./lists";

test("parses entries, comments, pins, and warns on unpinned lines", () => {
  const text = [
    "# curated skills",
    "obra/superpowers@v4.2.0",
    "wagglebot/skills@3f2a9c1   # first-party",
    "acme/internal-skills",
    "",
  ].join("\n");
  const { entries, warnings } = parseList(text);
  expect(entries).toEqual([
    { repo: "obra/superpowers", ref: "v4.2.0", raw: "obra/superpowers@v4.2.0" },
    { repo: "wagglebot/skills", ref: "3f2a9c1", raw: "wagglebot/skills@3f2a9c1" },
    { repo: "acme/internal-skills", ref: undefined, raw: "acme/internal-skills" },
  ]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("acme/internal-skills");
});

test("a malformed line throws and names the line", () => {
  expect(() => parseList("not-a-repo")).toThrow("not-a-repo");
});

test("a full git URL passes through verbatim, without a pin warning", () => {
  const text = [
    "https://git.my-company.local/platform/skills.git",
    "git@git.my-company.local:platform/skills.git",
    "ssh://git@git.my-company.local/platform/skills.git",
  ].join("\n");
  const { entries, warnings } = parseList(text);
  expect(entries.map((e) => e.raw)).toEqual(text.split("\n"));
  expect(entries.every((e) => e.isUrl === true)).toBe(true);
  expect(warnings).toHaveLength(0);
});

test("replaceListLine rewrites the entry line only and keeps its trailing comment", () => {
  const text = [
    "# obra/superpowers@v6.3.0 is the stable one",
    "obra/superpowers@v6.3.0   # keep me",
    "obra/superpowers@v6.3.0",
    "",
  ].join("\n");
  expect(replaceListLine(text, "obra/superpowers@v6.3.0", "obra/superpowers@v6.4.0")).toBe(
    [
      "# obra/superpowers@v6.3.0 is the stable one",
      "obra/superpowers@v6.4.0   # keep me",
      "obra/superpowers@v6.3.0",
      "",
    ].join("\n"),
  );
});

test("VERSION_TAG accepts version tags only", () => {
  expect(VERSION_TAG.test("v6.3.0")).toBe(true);
  expect(VERSION_TAG.test("6.3")).toBe(true);
  expect(VERSION_TAG.test("main")).toBe(false);
  expect(VERSION_TAG.test("1a2b3c4")).toBe(false);
});
