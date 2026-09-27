import { lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { join } from "node:path";

import { assertSafeText } from "@wagglebot/secret-scanner";

import { Bm25Index } from "../bm25/index";
import { assertInside, LocalBrainError, resolveProjectPath } from "../path-policy";
import type {
  LocalMemoryBundle,
  LocalMemoryChunk,
  LocalMemoryConcept,
  LocalMemoryProposal,
  LocalMemoryProposalInput,
  LocalMemorySaveResult,
  LocalMemorySearchResult,
} from "../types";
import { loadMemoryBundle } from "./bundle";
import { repairMemoryIndexes } from "./lifecycle";
import { parseConcept } from "./parse";
import { assertProjectedBundleSize, buildProposal, canonicalProposalValue, verifyProposal } from "./proposal";
import { writeMemoryAtomically } from "./write";

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

type CachedSearch = {
  bundleHash: string;
  index: Bm25Index<LocalMemoryChunk>;
};

export type MarkdownMemoryProviderOptions = {
  write?: (target: string, content: string) => void;
};

const asMemoryError = (error: unknown): never => {
  if (error instanceof LocalBrainError) throw error;
  throw new LocalBrainError("local_brain_internal", "local memory is unavailable");
};

const stableTieMatch = (chunk: LocalMemoryChunk, query: string): boolean => {
  const normalizedQuery = query.trim().toLowerCase();
  return (
    chunk.title.toLowerCase() === normalizedQuery ||
    chunk.headingPath.some((heading) => heading.toLowerCase() === normalizedQuery)
  );
};

const compareHits = (
  left: { item: LocalMemoryChunk; score: number },
  right: { item: LocalMemoryChunk; score: number },
  query: string,
): number =>
  right.score - left.score ||
  Number(stableTieMatch(right.item, query)) - Number(stableTieMatch(left.item, query)) ||
  (left.item.id < right.item.id ? -1 : left.item.id > right.item.id ? 1 : 0);

const semanticFields = (proposal: LocalMemoryProposal) => ({
  baseBundleHash: proposal.baseBundleHash,
  path: proposal.path,
  section: proposal.section,
  title: proposal.title,
  summary: proposal.summary,
  evidence: proposal.evidence,
  ...(proposal.replace === undefined ? {} : { replace: proposal.replace }),
  action: proposal.action,
  content: proposal.content,
  warnings: proposal.warnings,
});

const safeDirectory = (projectRoot: string, proposalPath: string): { path: string; created: boolean } => {
  const parentSegments = proposalPath.split("/").slice(0, -1);
  const path = join(projectRoot, ...parentSegments);
  const bundleRoot = realpathSync(join(projectRoot, ".agents", "memory"));
  assertInside(projectRoot, bundleRoot);
  assertInside(bundleRoot, path);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new LocalBrainError("path_outside_repository", "memory concept path is unsafe");
    if (!stat.isDirectory()) throw new LocalBrainError("local_memory_invalid", "memory category is not a directory");
    const realDirectory = realpathSync(path);
    assertInside(projectRoot, realDirectory);
    assertInside(bundleRoot, realDirectory);
    return { path, created: false };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  try {
    mkdirSync(path);
    const realDirectory = realpathSync(path);
    assertInside(projectRoot, realDirectory);
    assertInside(bundleRoot, realDirectory);
    return { path, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new LocalBrainError("path_outside_repository", "memory concept path is unsafe");
    if (!stat.isDirectory()) throw new LocalBrainError("local_memory_invalid", "memory category is not a directory");
    const realDirectory = realpathSync(path);
    assertInside(projectRoot, realDirectory);
    assertInside(bundleRoot, realDirectory);
    return { path, created: false };
  }
};

export class MarkdownMemoryProvider {
  readonly #cache = new Map<string, CachedSearch>();
  readonly #write: (target: string, content: string) => void;

  constructor(options: MarkdownMemoryProviderOptions = {}) {
    this.#write = options.write ?? writeMemoryAtomically;
  }

  async read(projectRoot: string): Promise<LocalMemoryBundle | undefined> {
    try {
      const project = await resolveProjectPath(projectRoot);
      return loadMemoryBundle(project.root);
    } catch (error) {
      return asMemoryError(error);
    }
  }

  async search(input: { projectRoot: string; query: string; limit: number }): Promise<LocalMemorySearchResult> {
    if (typeof input.query !== "string" || [...input.query].length < 1 || [...input.query].length > 2_000) {
      throw new LocalBrainError("local_memory_invalid", "local memory query is invalid");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) {
      throw new LocalBrainError("local_memory_invalid", "local memory result limit is invalid");
    }

    const project = await resolveProjectPath(input.projectRoot);
    const bundle = await this.read(project.root);
    if (bundle === undefined) return { hits: [] };

    const cached = this.#cache.get(project.root);
    const search =
      cached?.bundleHash === bundle.bundleHash
        ? cached.index
        : new Bm25Index(
            bundle.concepts.flatMap((concept) => concept.chunks),
            (chunk) =>
              [
                chunk.type,
                chunk.title,
                chunk.description ?? "",
                chunk.tags.join(" "),
                chunk.headingPath.join(" "),
                chunk.content,
              ].join("\n"),
            (chunk) => chunk.id,
          );
    if (cached?.bundleHash !== bundle.bundleHash)
      this.#cache.set(project.root, { bundleHash: bundle.bundleHash, index: search });

    const scored = search
      .search(input.query, Number.MAX_SAFE_INTEGER)
      .sort((left, right) => compareHits(left, right, input.query));
    return {
      hits: scored.slice(0, input.limit).map(({ item, score }) => ({ ...item, score })),
      bundleHash: bundle.bundleHash,
    };
  }

  async propose(input: LocalMemoryProposalInput): Promise<LocalMemoryProposal> {
    const project = await resolveProjectPath(input.projectRoot);
    const bundle = await this.read(project.root);
    if (bundle === undefined) {
      throw new LocalBrainError("local_memory_invalid", "local memory bundle is not initialized");
    }
    return buildProposal({ ...input, projectRoot: project.root }, bundle);
  }

  async save(input: { projectRoot: string; proposal: LocalMemoryProposal }): Promise<LocalMemorySaveResult> {
    if (!verifyProposal(input.proposal)) {
      throw new LocalBrainError("proposal_invalid", "proposal cannot be saved");
    }
    const project = await resolveProjectPath(input.projectRoot);
    const bundle = await this.read(project.root);
    if (bundle === undefined || input.proposal.baseBundleHash !== bundle.bundleHash) {
      throw new LocalBrainError("memory_changed", "local memory changed before save");
    }

    const semanticInput: LocalMemoryProposalInput = {
      projectRoot: project.root,
      section: input.proposal.section,
      title: input.proposal.title,
      summary: input.proposal.summary,
      evidence: input.proposal.evidence,
      ...(input.proposal.replace === undefined ? {} : { replace: input.proposal.replace }),
    };
    const expected = buildProposal(semanticInput, bundle);
    if (canonicalProposalValue(semanticFields(input.proposal)) !== canonicalProposalValue(semanticFields(expected))) {
      throw new LocalBrainError("proposal_invalid", "proposal does not match its semantic fields");
    }
    if (expected.action === "no_change")
      throw new LocalBrainError("proposal_invalid", "no-change proposals cannot be saved");
    if (expected.action === "needs_resolution")
      throw new LocalBrainError("proposal_conflict", "proposal needs resolution before save");
    if (expected.action !== "add" && expected.action !== "replace") {
      throw new LocalBrainError("proposal_invalid", "proposal cannot be saved");
    }

    let parsedConcept: LocalMemoryConcept;
    try {
      assertSafeText(expected.content);
      parsedConcept = parseConcept(expected.content, expected.path);
    } catch (error) {
      if (error instanceof LocalBrainError && error.code === "secret_rejected") throw error;
      throw new LocalBrainError("secret_rejected", "memory content contains unsafe text");
    }
    const nextConcepts = bundle.concepts.filter((concept) => concept.path !== expected.path).concat(parsedConcept);
    assertProjectedBundleSize(bundle, expected, nextConcepts);

    let directory: { path: string; created: boolean };
    try {
      directory = safeDirectory(project.root, expected.path);
    } catch (error) {
      return asMemoryError(error);
    }
    try {
      this.#write(join(project.root, ...expected.path.split("/")), expected.content);
    } catch {
      if (directory.created) {
        try {
          rmdirSync(directory.path);
        } catch {
          // The directory is removed only when it is still empty.
        }
      }
      throw new LocalBrainError("local_brain_internal", "local memory concept could not be saved");
    }

    this.#cache.delete(project.root);
    let afterConcept = await this.read(project.root);
    if (afterConcept === undefined) {
      throw new LocalBrainError("local_brain_internal", "saved concept could not be loaded");
    }

    let finalBundle: LocalMemoryBundle;
    let warnings: string[] = [];
    try {
      finalBundle = repairMemoryIndexes(project.root, afterConcept, this.#write);
    } catch {
      afterConcept = await this.read(project.root);
      if (afterConcept === undefined) {
        throw new LocalBrainError("local_brain_internal", "saved concept could not be loaded");
      }
      finalBundle = afterConcept;
      warnings = ["indexes_stale"];
    }

    return {
      path: expected.path,
      action: expected.action,
      previousBundleHash: bundle.bundleHash,
      newBundleHash: finalBundle.bundleHash,
      patch: expected.patch,
      warnings,
    };
  }
}
