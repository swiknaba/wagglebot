import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LocalBrainError } from "../path-policy";
import { loadMemoryBundle } from "./bundle";
import { conceptText, fixtureRepo, writeConcept, writeMemory } from "./test-fixture";

const memoryRoot = (root: string): string => join(root, ".agents", "memory");
const writeReserved = (root: string, path: string, text: string): void => {
  const target = join(memoryRoot(root), path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text);
};
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const localMemoryError = (operation: () => unknown): LocalBrainError => {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(LocalBrainError);
  return thrown as LocalBrainError;
};

test("returns undefined for a missing bundle but guides legacy users toward the bundle path", () => {
  const absent = fixtureRepo();
  expect(loadMemoryBundle(absent)).toBeUndefined();

  const legacy = fixtureRepo();
  writeMemory(legacy, "# Component Memory\n");
  const error = localMemoryError(() => loadMemoryBundle(legacy));
  expect(error.code).toBe("local_memory_invalid");
  expect(error.message).toContain(".agents/memory/");
  expect(error.message).not.toContain(legacy);
});

test("recursively sorts concepts and separates reserved index and log files", () => {
  const repo = fixtureRepo();
  writeConcept(repo, "warnings/z-last.md", conceptText());
  writeConcept(repo, "component.md", conceptText({ type: "Component Overview" }));
  writeConcept(repo, "architecture/first.md", conceptText({ type: "Architecture" }));
  writeReserved(repo, "index.md", '---\nokf_version: "0.2"\n---\n\n# Component Memory\n');
  writeReserved(repo, "warnings/index.md", "# Warnings\n");
  writeReserved(repo, "log.md", "# Memory Log\n\n## 2026-09-27\n\nCreated.\n");
  writeReserved(repo, "warnings/log.md", "# Warning Log\n\n## 2026-09-26\n\nNoted.\n");

  const bundle = loadMemoryBundle(repo);

  expect(bundle?.concepts.map(({ relativePath }) => relativePath)).toEqual([
    "architecture/first.md",
    "component.md",
    "warnings/z-last.md",
  ]);
  expect(bundle?.indexes.map(({ path }) => path)).toEqual([
    ".agents/memory/index.md",
    ".agents/memory/warnings/index.md",
  ]);
  expect(bundle?.logs.map(({ path }) => path)).toEqual([".agents/memory/log.md", ".agents/memory/warnings/log.md"]);
  expect(bundle?.indexState).toBe("stale");
});

test("counts reserved Markdown bytes toward the bundle size limit", () => {
  const repo = fixtureRepo();
  writeConcept(repo, "small.md", conceptText());
  writeReserved(repo, "log.md", `# Memory Log\n${"x".repeat(256 * 1024)}`);

  expect(localMemoryError(() => loadMemoryBundle(repo)).code).toBe("local_memory_too_large");
});

test("bundleHash depends on sorted concept paths and hashes but ignores reserved text", () => {
  const repo = fixtureRepo();
  const firstText = conceptText({ title: "First", body: "First claim." });
  const secondText = conceptText({ title: "Second", body: "Second claim." });
  writeConcept(repo, "warnings/second.md", secondText);
  writeConcept(repo, "architecture/first.md", firstText);
  writeReserved(repo, "index.md", '---\nokf_version: "0.2"\n---\n\n# Old index\n');
  writeReserved(repo, "log.md", "# Memory Log\n\n## 2026-09-27\n\nFirst note.\n");

  const firstBundle = loadMemoryBundle(repo);
  expect(firstBundle).toBeDefined();
  expect(firstBundle?.bundleHash).toBe(
    sha256([`architecture/first.md\0${sha256(firstText)}`, `warnings/second.md\0${sha256(secondText)}`].join("\0")),
  );

  writeReserved(repo, "index.md", '---\nokf_version: "0.2"\n---\n\n# Rewritten index\n');
  writeReserved(repo, "log.md", "# Memory Log\n\n## 2026-09-27\n\nDifferent note.\n");
  expect(loadMemoryBundle(repo)?.bundleHash).toBe(firstBundle?.bundleHash ?? "");
});

test("an existing empty bundle is valid and hashes the empty concept set", () => {
  const repo = fixtureRepo();
  mkdirSync(memoryRoot(repo), { recursive: true });

  const bundle = loadMemoryBundle(repo);

  expect(bundle?.concepts).toEqual([]);
  expect(bundle?.bundleHash).toBe(sha256(""));
  expect(bundle?.indexState).toBe("missing");
});

test("malformed root and nested concepts report only their repository-relative paths", () => {
  const malformedConcepts: Array<[string, string]> = [
    ["root.md", "root.md"],
    ["warnings/nested.md", "warnings/nested.md"],
  ];
  for (const [relative, expectedPath] of malformedConcepts) {
    const repo = fixtureRepo();
    writeConcept(repo, relative, "---\ntype: Warning\nsecret: [TOP_SECRET\n---\n");

    const error = localMemoryError(() => loadMemoryBundle(repo));

    expect(error.code).toBe("local_memory_invalid");
    expect(error.message).toContain(expectedPath);
    expect(error.message).not.toContain(repo);
    expect(error.message).not.toContain("TOP_SECRET");
  }
});

test("rejects symlinked files and directories inside the bundle", () => {
  const external = fixtureRepo();
  const outsideFile = writeConcept(external, "outside.md", conceptText());
  const outsideDirectory = memoryRoot(external);

  const fileRepo = fixtureRepo();
  mkdirSync(memoryRoot(fileRepo), { recursive: true });
  symlinkSync(outsideFile, join(memoryRoot(fileRepo), "linked.md"));
  expect(localMemoryError(() => loadMemoryBundle(fileRepo)).code).toBe("path_outside_repository");

  const directoryRepo = fixtureRepo();
  mkdirSync(memoryRoot(directoryRepo), { recursive: true });
  symlinkSync(outsideDirectory, join(memoryRoot(directoryRepo), "linked"));
  expect(localMemoryError(() => loadMemoryBundle(directoryRepo)).code).toBe("path_outside_repository");
});

test("accepts dated log headings and rejects non-date H2 headings", () => {
  const accepted = fixtureRepo();
  writeReserved(accepted, "log.md", "# Memory Log\n\n## 2026-09-27\n\nA note.\n## 2026-09-28\n\nAnother note.\n");
  expect(loadMemoryBundle(accepted)?.logs).toHaveLength(1);

  const rejected = fixtureRepo();
  writeReserved(rejected, "log.md", "# Memory Log\n\n## Today\n\nA note.\n");
  expect(localMemoryError(() => loadMemoryBundle(rejected)).code).toBe("local_memory_invalid");
});

test("validates root index version YAML and forbids frontmatter on category indexes", () => {
  const invalidRoots = [
    "---\nokf_version: [broken\n---\n\n# Component Memory\n",
    "---\nokf_version: 0.2\n---\n\n# Component Memory\n",
    "---\nother: value\n---\n\n# Component Memory\n",
  ];
  for (const text of invalidRoots) {
    const repo = fixtureRepo();
    writeReserved(repo, "index.md", text);
    expect(localMemoryError(() => loadMemoryBundle(repo)).code).toBe("local_memory_invalid");
  }

  const category = fixtureRepo();
  writeReserved(category, "warnings/index.md", "---\ntitle: Warnings\n---\n\n# Warnings\n");
  expect(localMemoryError(() => loadMemoryBundle(category)).code).toBe("local_memory_invalid");
});
