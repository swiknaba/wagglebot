import { expect, test } from "bun:test";
import { parseList } from "./lists";

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
