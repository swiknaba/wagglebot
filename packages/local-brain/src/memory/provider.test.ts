import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LocalBrainError } from "../path-policy";
import { MarkdownMemoryProvider } from "./provider";
import { conceptText, fixtureRepo, writeConcept } from "./test-fixture";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

test("search indexes concept metadata and body and returns exact source provenance", async () => {
  const repo = fixtureRepo();
  writeConcept(
    repo,
    "architecture/token-rotation.md",
    conceptText({
      type: "Architecture",
      title: "Token rotation",
      description: "The vault owns rotation.",
      extra: "tags: [security]",
      body: "# Owner\n\nRotate the token after a successful refresh.\n",
    }),
  );
  writeConcept(
    repo,
    "commands/retry-check.md",
    conceptText({ type: "Command", title: "Retry check", body: "Run bun test.\n" }),
  );
  writeConcept(
    repo,
    "warnings/charge-retry.md",
    conceptText({
      type: "Warning",
      title: "Charge retry",
      body: "Check the idempotency record before retrying a charge.\n",
    }),
  );
  writeFileSync(join(repo, ".agents", "memory", "index.md"), '---\nokf_version: "0.2"\n---\n\n# Component Memory\n');
  writeFileSync(join(repo, ".agents", "memory", "log.md"), "# Memory Log\n\n## 2026-09-27\n\ncharge retry history\n");
  const provider = new MarkdownMemoryProvider();

  const result = await provider.search({ projectRoot: repo, query: "rotation", limit: 10 });

  expect(result.bundleHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(result.hits.map(({ path }) => path)).toEqual([".agents/memory/architecture/token-rotation.md"]);
  expect(result.hits[0]).toMatchObject({
    type: "Architecture",
    title: "Token rotation",
    headingPath: ["Owner"],
    content: "Rotate the token after a successful refresh.",
    startLine: 10,
    endLine: 10,
  });
  expect(result.hits[0]?.contentHash).toBe(sha256("Rotate the token after a successful refresh."));
  expect(result.hits[0]?.score).toBeGreaterThan(0);

  for (const query of ["Architecture", "vault", "security", "Owner", "successful refresh"]) {
    expect((await provider.search({ projectRoot: repo, query, limit: 10 })).hits.length).toBeGreaterThan(0);
  }
  expect((await provider.search({ projectRoot: repo, query: "history", limit: 10 })).hits).toEqual([]);
  expect((await provider.search({ projectRoot: repo, query: "Component Memory", limit: 10 })).hits).toEqual([]);
});

test("search returns root-level concepts under the general bundle path", async () => {
  const repo = fixtureRepo();
  writeConcept(
    repo,
    "component.md",
    conceptText({
      type: "Component Overview",
      title: "Component overview",
      body: "Project boundaries are documented here.",
    }),
  );
  const result = await new MarkdownMemoryProvider().search({
    projectRoot: repo,
    query: "Project boundaries",
    limit: 5,
  });

  expect(result.hits.map(({ path }) => path)).toEqual([".agents/memory/component.md"]);
});

test("a changed concept changes the search snapshot while index-only changes do not", async () => {
  const repo = fixtureRepo();
  const conceptPath = writeConcept(repo, "warnings/retry.md", conceptText({ body: "Do not retry charge writes.\n" }));
  const provider = new MarkdownMemoryProvider();
  const first = await provider.search({ projectRoot: repo, query: "charge", limit: 5 });
  writeFileSync(join(repo, ".agents", "memory", "index.md"), '---\nokf_version: "0.2"\n---\n\n# Changed index\n');
  const afterIndex = await provider.search({ projectRoot: repo, query: "charge", limit: 5 });
  writeFileSync(conceptPath, conceptText({ body: "Use an idempotency record for every charge.\n" }));
  const afterConcept = await provider.search({ projectRoot: repo, query: "charge", limit: 5 });

  expect(first.bundleHash ?? "").toBe(afterIndex.bundleHash ?? "");
  expect(afterConcept.bundleHash ?? "").not.toBe(first.bundleHash ?? "");
  expect(afterConcept.hits[0]?.content).toContain("idempotency");
});

test("search returns the bundle hash from the same snapshot as its hits", async () => {
  const repo = fixtureRepo();
  writeConcept(repo, "warnings/retry.md", conceptText({ body: "The original charge must be reconciled.\n" }));
  const provider = new MarkdownMemoryProvider();
  const originalRead = provider.read.bind(provider);
  let oldHash = "";
  provider.read = async (projectRoot: string) => {
    const bundle = await originalRead(projectRoot);
    oldHash = bundle?.bundleHash ?? "";
    writeConcept(repo, "warnings/retry.md", conceptText({ body: "A replacement contains different wording.\n" }));
    return bundle;
  };

  const result = await provider.search({ projectRoot: repo, query: "original charge", limit: 5 });

  expect(result.bundleHash).toBe(oldHash);
  expect(result.hits[0]?.content).toContain("original charge");
  expect(result.hits[0]?.content).not.toContain("replacement");
});

test("exact title ties are ranked before truncation while lower scores remain lower", async () => {
  const repo = fixtureRepo();
  writeConcept(
    repo,
    "warnings/a-high.md",
    conceptText({ type: "Warning", title: "High", extra: "tags: [shared]", body: "Needle needle needle." }),
  );
  writeConcept(
    repo,
    "warnings/b-decoy.md",
    conceptText({ type: "Warning", title: "Else", extra: "tags: [shared]", body: "Needle." }),
  );
  writeConcept(
    repo,
    "warnings/c-exact.md",
    conceptText({ type: "Warning", title: "Needle", extra: "tags: [shared]", body: "Claim." }),
  );
  writeConcept(
    repo,
    "warnings/d-low.md",
    conceptText({
      type: "Warning",
      title: "Low",
      extra: "tags: [shared]",
      body: "Needle with many extra words to make it longer.",
    }),
  );
  const provider = new MarkdownMemoryProvider();

  const all = (await provider.search({ projectRoot: repo, query: "needle", limit: 20 })).hits;
  const limited = (await provider.search({ projectRoot: repo, query: "needle", limit: 2 })).hits;

  expect(all[0]?.path).toBe(".agents/memory/warnings/a-high.md");
  expect(all[1]?.path).toBe(".agents/memory/warnings/c-exact.md");
  expect(all[2]?.path).toBe(".agents/memory/warnings/b-decoy.md");
  expect(all[1]?.score ?? -1).toBe(all[2]?.score ?? -2);
  expect(all[3]?.score).toBeLessThan(all[2]?.score ?? 0);
  expect(limited.map(({ path }) => path)).toEqual([
    ".agents/memory/warnings/a-high.md",
    ".agents/memory/warnings/c-exact.md",
  ]);
});

test("missing bundles return an empty envelope without a bundle hash", async () => {
  const result = await new MarkdownMemoryProvider().search({ projectRoot: fixtureRepo(), query: "charge", limit: 5 });
  expect(result).toEqual({ hits: [] });
});

test("maps malformed, oversized, legacy, and symlink bundles to stable errors", async () => {
  const malformed = fixtureRepo();
  writeConcept(malformed, "warnings/bad.md", "---\ntype: [malformed\n---\n");
  await expect(
    new MarkdownMemoryProvider().search({ projectRoot: malformed, query: "bad", limit: 5 }),
  ).rejects.toMatchObject({
    code: "local_memory_invalid",
  } satisfies Partial<LocalBrainError>);

  const oversized = fixtureRepo();
  writeConcept(oversized, "warnings/large.md", conceptText({ body: "x".repeat(257 * 1024) }));
  await expect(new MarkdownMemoryProvider().read(oversized)).rejects.toMatchObject({
    code: "local_memory_too_large",
  } satisfies Partial<LocalBrainError>);

  const legacy = fixtureRepo();
  mkdirSync(join(legacy, ".agents"), { recursive: true });
  writeFileSync(join(legacy, ".agents", "memory.md"), "# legacy\n");
  await expect(new MarkdownMemoryProvider().read(legacy)).rejects.toMatchObject({
    code: "local_memory_invalid",
  } satisfies Partial<LocalBrainError>);

  const linked = fixtureRepo();
  writeConcept(linked, "warnings/retry.md", conceptText());
  symlinkSync(
    join(linked, ".agents", "memory", "warnings", "retry.md"),
    join(linked, ".agents", "memory", "warnings", "linked.md"),
  );
  await expect(new MarkdownMemoryProvider().read(linked)).rejects.toMatchObject({
    code: "path_outside_repository",
  } satisfies Partial<LocalBrainError>);
});
