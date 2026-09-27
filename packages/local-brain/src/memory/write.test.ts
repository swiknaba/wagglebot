import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMemoryBundle } from "./bundle";
import { ensureLocalMemoryBundle } from "./lifecycle";
import { MarkdownMemoryProvider } from "./provider";
import { conceptText, fixtureRepo, writeConcept } from "./test-fixture";
import { writeMemoryAtomically } from "./write";

const input = (projectRoot: string) => ({
  projectRoot,
  section: "Warnings" as const,
  title: "Retries can duplicate a charge",
  summary: "Do not retry a timed-out charge until its idempotency record is checked.",
  evidence: [{ kind: "file" as const, ref: "src/payments/charge.ts:74" }],
});

const setup = (repo = fixtureRepo()) => {
  writeConcept(repo, "component.md", conceptText({ type: "Component Overview", title: "Component overview" }));
  return repo;
};

test("a concept edit after proposal creation conflicts through the authoritative bundle hash", async () => {
  const repo = setup();
  const provider = new MarkdownMemoryProvider();
  const proposal = await provider.propose(input(repo));
  writeConcept(
    repo,
    "component.md",
    conceptText({ type: "Component Overview", title: "Component overview", body: "Changed purpose." }),
  );

  await expect(provider.save({ projectRoot: repo, proposal })).rejects.toMatchObject({ code: "memory_changed" });
});

test("index-only drift is accepted and regenerated from the current concepts", async () => {
  const repo = setup();
  const provider = new MarkdownMemoryProvider();
  const proposal = await provider.propose(input(repo));
  const before = (await provider.read(repo))?.bundleHash;
  writeFileSync(join(repo, ".agents", "memory", "index.md"), '---\nokf_version: "0.2"\n---\n\n# Stale by design\n');
  const result = await provider.save({ projectRoot: repo, proposal });
  const after = await provider.read(repo);

  expect(result.previousBundleHash).toBe(before ?? "");
  expect(after?.bundleHash).toBe(result.newBundleHash);
  expect(after?.indexState).toBe("current");
  expect(readFileSync(join(repo, ".agents", "memory", "index.md"), "utf8")).toContain("[Warnings](warnings/index.md)");
});

test("proposal ID validation rejects tampering before the bundle conflict check", async () => {
  const repo = setup();
  const provider = new MarkdownMemoryProvider();
  const proposal = await provider.propose(input(repo));
  writeConcept(repo, "component.md", conceptText({ type: "Component Overview", title: "Changed component" }));
  const tampered = [
    { ...proposal, proposalId: "tampered" },
    { ...proposal, baseBundleHash: "a".repeat(64) },
    { ...proposal, path: ".agents/memory/warnings/another.md" as const },
    { ...proposal, section: "Decisions" as const },
    { ...proposal, content: `${proposal.content}tampered\n` },
    { ...proposal, action: "replace" as const },
    { ...proposal, evidence: [{ kind: "file" as const, ref: "src/other.ts" }] },
    { ...proposal, title: "Different title" },
    { ...proposal, summary: "Different summary." },
    { ...proposal, replace: { path: ".agents/memory/warnings/old.md" as const, contentHash: "b".repeat(64) } },
  ];

  for (const changed of tampered) {
    await expect(provider.save({ projectRoot: repo, proposal: changed })).rejects.toMatchObject({
      code: "proposal_invalid",
    });
  }
});

test("proposal ID covers derived index changes and patch while save regenerates them after index drift", async () => {
  const repo = setup();
  const provider = new MarkdownMemoryProvider();
  const proposal = await provider.propose(input(repo));
  await expect(provider.save({ projectRoot: repo, proposal: { ...proposal, patch: "changed" } })).rejects.toMatchObject(
    {
      code: "proposal_invalid",
    },
  );
  await expect(provider.save({ projectRoot: repo, proposal: { ...proposal, indexChanges: [] } })).rejects.toMatchObject(
    {
      code: "proposal_invalid",
    },
  );

  writeFileSync(join(repo, ".agents", "memory", "index.md"), '---\nokf_version: "0.2"\n---\n\n# Stale index\n');
  const result = await provider.save({ projectRoot: repo, proposal });
  expect(result.patch).toContain("# Component Memory");
  expect((await provider.read(repo))?.indexState).toBe("current");
});

test("successful add writes one concept and regenerated indexes without staging or committing", async () => {
  const repo = setup();
  const provider = new MarkdownMemoryProvider();
  const proposal = await provider.propose(input(repo));
  const result = await provider.save({ projectRoot: repo, proposal });

  expect(result).toMatchObject({
    path: proposal.path,
    action: "add",
    previousBundleHash: proposal.baseBundleHash,
    warnings: [],
  });
  expect(result.newBundleHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(readFileSync(join(repo, proposal.path), "utf8")).toBe(proposal.content);
  expect((await provider.read(repo))?.indexState).toBe("current");
  expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo }).stdout.toString()).not.toContain("A  ");
});

test("save replaces only the selected concept path", async () => {
  const repo = setup();
  const oldPath = "warnings/old-name.md";
  writeConcept(repo, oldPath, conceptText({ type: "Warning", title: "Old title", body: "Old warning." }));
  const provider = new MarkdownMemoryProvider();
  const existing = (await provider.read(repo))?.concepts.find(({ relativePath }) => relativePath === oldPath);
  const proposal = await provider.propose({
    ...input(repo),
    title: "Replacement warning",
    replace: { path: `.agents/memory/${oldPath}` as const, contentHash: existing?.contentHash ?? "" },
  });
  const result = await provider.save({ projectRoot: repo, proposal });
  expect(result.action).toBe("replace");
  expect(result.path).toBe(`.agents/memory/${oldPath}`);
  expect(readFileSync(join(repo, ".agents", "memory", oldPath), "utf8")).toContain("Replacement warning");
  expect(existsSync(join(repo, ".agents", "memory", "warnings", "replacement-warning.md"))).toBe(false);
});

test("no-change and unresolved proposals are rejected before invoking the writer", async () => {
  const repo = setup();
  const provider = new MarkdownMemoryProvider();
  const added = await provider.propose(input(repo));
  await provider.save({ projectRoot: repo, proposal: added });
  const duplicate = await provider.propose(input(repo));
  const unresolved = await provider.propose({ ...input(repo), summary: "Retry every failed charge immediately." });
  let writes = 0;
  const tracking = new MarkdownMemoryProvider({
    write: () => {
      writes += 1;
    },
  });
  await expect(tracking.save({ projectRoot: repo, proposal: duplicate })).rejects.toMatchObject({
    code: "proposal_invalid",
  });
  await expect(tracking.save({ projectRoot: repo, proposal: unresolved })).rejects.toMatchObject({
    code: "proposal_conflict",
  });
  expect(writes).toBe(0);
});

test("concept-write failure leaves originals intact and removes only its newly created empty category directory", async () => {
  const repo = setup();
  const provider = new MarkdownMemoryProvider({
    write: () => {
      throw new Error("disk full");
    },
  });
  const proposal = await provider.propose(input(repo));
  const before = readFileSync(join(repo, ".agents", "memory", "component.md"), "utf8");
  await expect(provider.save({ projectRoot: repo, proposal })).rejects.toMatchObject({ code: "local_brain_internal" });
  expect(readFileSync(join(repo, ".agents", "memory", "component.md"), "utf8")).toBe(before);
  expect(Bun.spawnSync(["test", "-d", join(repo, ".agents", "memory", "warnings")]).exitCode).toBe(1);

  mkdirSync(join(repo, ".agents", "memory", "warnings"));
  const existingDirectoryProvider = new MarkdownMemoryProvider({
    write: () => {
      throw new Error("disk full");
    },
  });
  const anotherProposal = await existingDirectoryProvider.propose(input(repo));
  await expect(existingDirectoryProvider.save({ projectRoot: repo, proposal: anotherProposal })).rejects.toMatchObject({
    code: "local_brain_internal",
  });
  expect(Bun.spawnSync(["test", "-d", join(repo, ".agents", "memory", "warnings")]).exitCode).toBe(0);
});

test("index-write failure leaves the concept searchable and reports its actual bundle hash", async () => {
  const repo = setup();
  let writes = 0;
  const provider = new MarkdownMemoryProvider({
    write: (target, content) => {
      writes += 1;
      if (writes === 2) throw new Error("index disk full");
      writeMemoryAtomically(target, content);
    },
  });
  const proposal = await provider.propose(input(repo));
  const result = await provider.save({ projectRoot: repo, proposal });

  expect(result.warnings).toEqual(["indexes_stale"]);
  expect(result.newBundleHash).toBe((await provider.read(repo))?.bundleHash ?? "");
  expect((await provider.search({ projectRoot: repo, query: "idempotency", limit: 5 })).hits[0]?.path).toBe(
    proposal.path,
  );
  const repaired = ensureLocalMemoryBundle(repo);
  expect(repaired.bundleHash).toBe(result.newBundleHash);
  expect(repaired.indexState).toBe("current");
});

test("near-cap preflight accounts for stale and obsolete indexes before invoking a writer", async () => {
  const repo = setup();
  const rootIndex = '---\nokf_version: "0.2"\n---\n\n# Stale root index\n';
  const obsoleteIndex = "# Obsolete Learnings\n\nThis index is no longer generated.\n";
  writeFileSync(join(repo, ".agents", "memory", "index.md"), rootIndex);
  writeConcept(repo, "learnings/index.md", obsoleteIndex);
  const withoutLog = loadMemoryBundle(repo);
  expect(withoutLog).toBeDefined();

  const maximumBytes = 256 * 1024;
  const targetBytes = maximumBytes - 128;
  const logPrefix = "# Memory Log\n\n## 2026-09-27\n\n";
  const paddingBytes = targetBytes - (withoutLog?.totalBytes ?? 0) - Buffer.byteLength(logPrefix) - 1;
  expect(paddingBytes).toBeGreaterThan(0);
  const log = `${logPrefix}${"x".repeat(paddingBytes)}\n`;
  writeFileSync(join(repo, ".agents", "memory", "log.md"), log);
  expect(loadMemoryBundle(repo)?.totalBytes).toBe(targetBytes);

  const provider = new MarkdownMemoryProvider();
  const proposal = await provider.propose(input(repo));
  let writes = 0;
  const tracking = new MarkdownMemoryProvider({
    write: () => {
      writes += 1;
    },
  });

  await expect(tracking.save({ projectRoot: repo, proposal })).rejects.toMatchObject({
    code: "local_memory_too_large",
  });
  expect(writes).toBe(0);
  expect(readFileSync(join(repo, ".agents", "memory", "index.md"), "utf8")).toBe(rootIndex);
  expect(readFileSync(join(repo, ".agents", "memory", "learnings", "index.md"), "utf8")).toBe(obsoleteIndex);
  expect(readFileSync(join(repo, ".agents", "memory", "log.md"), "utf8")).toBe(log);
});

test("a final replacement concept containing a secret is rejected before the writer", async () => {
  const repo = setup();
  const path = "warnings/unsafe-metadata.md";
  writeConcept(
    repo,
    path,
    `---\ntype: Warning\ntitle: Unsafe metadata\nproducer_note: "password: synthetic-password"\n---\n\nExisting claim.\n`,
  );
  const provider = new MarkdownMemoryProvider();
  const existing = (await provider.read(repo))?.concepts.find(({ relativePath }) => relativePath === path);
  const proposal = await provider.propose({
    ...input(repo),
    title: "Unsafe metadata",
    replace: {
      path: ".agents/memory/warnings/unsafe-metadata.md",
      contentHash: existing?.contentHash ?? "",
    },
  });
  let writes = 0;
  const tracking = new MarkdownMemoryProvider({
    write: () => {
      writes += 1;
    },
  });

  await expect(tracking.save({ projectRoot: repo, proposal })).rejects.toMatchObject({ code: "secret_rejected" });
  expect(writes).toBe(0);
  expect(readFileSync(join(repo, ".agents", "memory", path), "utf8")).toContain(
    'producer_note: "password: synthetic-password"',
  );
});
