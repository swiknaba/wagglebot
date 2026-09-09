import { expect, test } from "bun:test";
import { hostPath, insideOrganization, parseList, replaceListLine, VERSION_TAG } from "./lists";

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

test("a full git URL passes through verbatim, and needs no pin inside the organization", () => {
  const text = [
    "https://git.my-company.local/platform/skills.git",
    "git@git.my-company.local:platform/skills.git",
    "ssh://git@git.my-company.local/platform/skills.git",
  ].join("\n");
  const { entries, warnings } = parseList(text, { organization: ["git.my-company.local"] });
  expect(entries.map((e) => e.raw)).toEqual(text.split("\n"));
  expect(entries.every((e) => e.isUrl === true)).toBe(true);
  expect(warnings).toHaveLength(0);
  expect(parseList(text).warnings).toHaveLength(3);
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

const one = (text: string) => {
  const entry = parseList(text).entries[0];
  if (entry === undefined) throw new Error("no entry");
  return entry;
};

test("hostPath normalizes shorthand, https, scp-like, and ssh URLs to host/path", () => {
  expect(hostPath(one("acme/tools"))).toBe("github.com/acme/tools");
  expect(hostPath(one("https://git.acme.local/platform/skills.git v1"))).toBe("git.acme.local/platform/skills");
  expect(hostPath(one("git@github.com:acme/tools.git"))).toBe("github.com/acme/tools");
  expect(hostPath(one("ssh://git@git.acme.local:2222/platform/skills.git"))).toBe(
    "git.acme.local:2222/platform/skills",
  );
});

test("insideOrganization matches a whole prefix segment only", () => {
  expect(insideOrganization(one("acme/tools"), ["github.com/acme"])).toBe(true);
  expect(insideOrganization(one("acme-labs/tools"), ["github.com/acme"])).toBe(false);
  expect(insideOrganization(one("https://git.acme.local/x/y.git"), ["git.acme.local"])).toBe(true);
  expect(insideOrganization(one("acme/tools"), [])).toBe(false);
  expect(insideOrganization(one("acme/tools"), ["github.com/acme/"])).toBe(true);
  expect(insideOrganization(one("acme/tools"), ["GitHub.com/Acme"])).toBe(true);
});

test("an unpinned entry inside the organization produces no warning", () => {
  expect(parseList("acme/tools\n", { organization: ["github.com/acme"] }).warnings).toEqual([]);
  expect(parseList("acme/tools\n").warnings.length).toBe(1);
  expect(parseList("acme/tools\n").warnings[0]).toContain("wagglebot.organization");
});
