import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LocalBrainError } from "../path-policy";
import { ensureLocalMemoryBundle } from "./lifecycle";
import { conceptText, fixtureRepo, writeConcept, writeMemory } from "./test-fixture";

const memoryRoot = (root: string): string => join(root, ".agents", "memory");

test("creates one initial component and generated indexes idempotently", () => {
  const repo = fixtureRepo();

  const first = ensureLocalMemoryBundle(repo);
  const componentPath = join(memoryRoot(repo), "component.md");
  const componentBefore = readFileSync(componentPath, "utf8");
  const second = ensureLocalMemoryBundle(repo);

  expect(first.path).toBe(".agents/memory");
  expect(first.concepts.map(({ relativePath }) => relativePath)).toEqual(["component.md"]);
  expect(readFileSync(join(memoryRoot(repo), "index.md"), "utf8")).toContain('okf_version: "0.2"');
  expect(componentBefore).toContain("type: Component Overview");
  expect(componentBefore).toContain("status: draft");
  expect(second.concepts[0]?.text).toBe(componentBefore);
  expect(readFileSync(componentPath, "utf8")).toBe(componentBefore);
});

test("does not create a component concept when an empty bundle already exists", () => {
  const repo = fixtureRepo();
  mkdirSync(memoryRoot(repo), { recursive: true });

  const bundle = ensureLocalMemoryBundle(repo);

  expect(bundle.concepts).toEqual([]);
  expect(existsSync(join(memoryRoot(repo), "component.md"))).toBe(false);
  expect(existsSync(join(memoryRoot(repo), "index.md"))).toBe(true);
});

test("repairs corrupted indexes without rewriting human concepts or logs", () => {
  const repo = fixtureRepo();
  ensureLocalMemoryBundle(repo);
  const componentPath = join(memoryRoot(repo), "component.md");
  const indexPath = join(memoryRoot(repo), "index.md");
  const humanPath = writeConcept(repo, "architecture.md", conceptText({ type: "Architecture", title: "Boundaries" }));
  const logPath = join(memoryRoot(repo), "log.md");
  mkdirSync(memoryRoot(repo), { recursive: true });
  writeFileSync(logPath, "# Memory Log\n\n## 2026-09-27\n\nRelease note.\n");
  writeFileSync(indexPath, '---\nokf_version: "0.2"\n---\n\n# Manually corrupted index\n');
  const before = {
    component: readFileSync(componentPath, "utf8"),
    human: readFileSync(humanPath, "utf8"),
    log: readFileSync(logPath, "utf8"),
  };

  const bundle = ensureLocalMemoryBundle(repo);

  expect(readFileSync(indexPath, "utf8")).toContain("[Boundaries](architecture.md)");
  expect(readFileSync(componentPath, "utf8")).toBe(before.component);
  expect(readFileSync(humanPath, "utf8")).toBe(before.human);
  expect(readFileSync(logPath, "utf8")).toBe(before.log);
  expect(bundle.indexState).toBe("current");
  expect(bundle.concepts.map(({ relativePath }) => relativePath)).toEqual(["architecture.md", "component.md"]);
});

test("legacy memory preflight fails before creating a bundle directory", () => {
  const repo = fixtureRepo();
  writeMemory(repo, "# Component Memory\n");

  let thrown: unknown;
  try {
    ensureLocalMemoryBundle(repo);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(LocalBrainError);
  expect((thrown as LocalBrainError).code).toBe("local_memory_invalid");
  expect((thrown as Error).message).toContain(".agents/memory/");
  expect(existsSync(memoryRoot(repo))).toBe(false);
});
