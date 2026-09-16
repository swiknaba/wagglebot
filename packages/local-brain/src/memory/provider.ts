import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { assertSafeText } from "@wagglebot/secret-scanner";

import { Bm25Index } from "../bm25/index";
import { LocalBrainError, resolveProjectPath } from "../path-policy";
import type { LocalMemoryHit, LocalMemoryProposal, LocalMemoryProposalInput, LocalMemorySaveResult } from "../types";
import { type LocalMemoryDocument, MemoryParseError, parseMemory } from "./parse";
import { buildProposal } from "./proposal";
import { writeMemoryAtomically } from "./write";

const MEMORY_PATH = ".agents/memory.md" as const;

type CachedDocument = {
  contentHash: string;
  index: Bm25Index<LocalMemoryDocument["chunks"][number]>;
};

export type MarkdownMemoryProviderOptions = {
  today?: () => string;
  write?: (target: string, content: string) => void;
};

const asMemoryError = (error: unknown): never => {
  if (error instanceof LocalBrainError) throw error;
  if (error instanceof MemoryParseError) {
    const code = error.message.includes("256 KiB") ? "local_memory_too_large" : "local_memory_invalid";
    throw new LocalBrainError(code, "local memory is invalid");
  }
  throw new LocalBrainError("local_brain_internal", "local memory is unavailable");
};

const hasExactHeading = (chunk: LocalMemoryDocument["chunks"][number], query: string): boolean =>
  chunk.headingPath.some((heading) => heading.toLocaleLowerCase() === query.trim().toLocaleLowerCase());

export class MarkdownMemoryProvider {
  readonly #cache = new Map<string, CachedDocument>();
  readonly #today: () => string;
  readonly #write: (target: string, content: string) => void;

  constructor(options: MarkdownMemoryProviderOptions = {}) {
    this.#today = options.today ?? (() => new Date().toISOString().slice(0, 10));
    this.#write = options.write ?? writeMemoryAtomically;
  }

  async read(projectRoot: string): Promise<LocalMemoryDocument | undefined> {
    const project = await resolveProjectPath(projectRoot);
    const target = join(project.root, MEMORY_PATH);
    let text: string;
    try {
      const bytes = await readFile(target);
      if (bytes.byteLength > 256 * 1024) throw new MemoryParseError("local memory exceeds 256 KiB");
      text = bytes.toString("utf8");
    } catch (error) {
      if (error instanceof MemoryParseError) return asMemoryError(error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return asMemoryError(error);
    }

    try {
      return parseMemory(text, MEMORY_PATH);
    } catch (error) {
      return asMemoryError(error);
    }
  }

  async search(input: { projectRoot: string; query: string; limit: number }): Promise<LocalMemoryHit[]> {
    if (typeof input.query !== "string" || [...input.query].length === 0 || [...input.query].length > 2_000) {
      throw new LocalBrainError("local_memory_invalid", "local memory query is invalid");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) {
      throw new LocalBrainError("local_memory_invalid", "local memory result limit is invalid");
    }

    const project = await resolveProjectPath(input.projectRoot);
    const document = await this.read(project.root);
    if (document === undefined) return [];

    let cached = this.#cache.get(project.root);
    if (cached?.contentHash !== document.contentHash) {
      cached = {
        contentHash: document.contentHash,
        index: new Bm25Index(
          document.chunks,
          (chunk) => `${chunk.headingPath.join(" ")}\n${chunk.content}`,
          (chunk) => chunk.id,
        ),
      };
      this.#cache.set(project.root, cached);
    }

    return cached.index
      .search(input.query, input.limit)
      .sort(
        (left, right) =>
          Number(hasExactHeading(right.item, input.query)) - Number(hasExactHeading(left.item, input.query)),
      )
      .map(({ item, score }) => ({ ...item, path: MEMORY_PATH, score }));
  }

  async propose(input: LocalMemoryProposalInput): Promise<LocalMemoryProposal> {
    const project = await resolveProjectPath(input.projectRoot);
    const document = await this.read(project.root);
    if (document === undefined)
      throw new LocalBrainError("local_memory_invalid", "component memory is not initialized");
    return buildProposal({ ...input, projectRoot: project.root }, document, this.#today());
  }

  async save(input: { projectRoot: string; proposal: LocalMemoryProposal }): Promise<LocalMemorySaveResult> {
    const project = await resolveProjectPath(input.projectRoot);
    const document = await this.read(project.root);
    if (document === undefined) throw new LocalBrainError("memory_changed", "component memory changed before save");
    if (input.proposal.baseContentHash !== document.contentHash) {
      throw new LocalBrainError("memory_changed", "component memory changed before save");
    }

    const matchingEntries = document.chunks.filter(
      (chunk) =>
        chunk.headingPath.length === 2 &&
        chunk.headingPath[0] === input.proposal.section &&
        chunk.headingPath[1]?.toLocaleLowerCase() === input.proposal.title.toLocaleLowerCase(),
    );
    const replacement =
      input.proposal.action === "replace" && matchingEntries.length === 1
        ? { title: input.proposal.title, contentHash: matchingEntries[0]?.contentHash ?? "" }
        : undefined;
    const expected = buildProposal(
      {
        projectRoot: project.root,
        section: input.proposal.section,
        title: input.proposal.title,
        summary: input.proposal.summary,
        evidence: input.proposal.evidence,
        ...(replacement === undefined ? {} : { replace: replacement }),
      },
      document,
      this.#today(),
    );
    if (
      input.proposal.proposalId !== expected.proposalId ||
      input.proposal.patch !== expected.patch ||
      input.proposal.action !== expected.action ||
      input.proposal.action === "no_change" ||
      input.proposal.action === "needs_resolution" ||
      expected.nextText === undefined
    ) {
      throw new LocalBrainError("proposal_invalid", "proposal cannot be saved");
    }
    const action = expected.action;
    if (action !== "add" && action !== "replace")
      throw new LocalBrainError("proposal_invalid", "proposal cannot be saved");

    try {
      assertSafeText(expected.nextText);
    } catch {
      throw new LocalBrainError("secret_rejected", "memory content contains unsafe text");
    }
    try {
      this.#write(join(project.root, MEMORY_PATH), expected.nextText);
    } catch {
      throw new LocalBrainError("local_brain_internal", "component memory could not be saved");
    }
    this.#cache.delete(project.root);
    const newDocument = await this.read(project.root);
    if (newDocument === undefined)
      throw new LocalBrainError("local_brain_internal", "component memory could not be read after save");
    return {
      path: MEMORY_PATH,
      action,
      previousContentHash: document.contentHash,
      newContentHash: newDocument.contentHash,
      patch: expected.patch,
    };
  }
}
