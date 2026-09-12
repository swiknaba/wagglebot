import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { assertSafeText } from "@wagglebot/secret-scanner";

import { LocalBrainError } from "../path-policy";
import type { LocalMemoryProposal, LocalMemoryProposalInput, LocalMemorySection, MemoryEvidence } from "../types";
import type { LocalMemoryDocument } from "./parse";

type ProposalAction = LocalMemoryProposal["action"];

const SECTIONS = new Set<LocalMemorySection>([
  "Architecture",
  "Conventions",
  "Commands",
  "Decisions",
  "Warnings",
  "Learnings",
]);
const EVIDENCE_KINDS = new Set<MemoryEvidence["kind"]>([
  "file",
  "commit",
  "adr",
  "issue",
  "test",
  "maintainer_confirmation",
]);

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const normalizeLines = (value: string): string => value.replace(/\r\n?/gu, "\n");
const normalizeTitle = (value: string): string => normalizeLines(value).trim().toLocaleLowerCase();
const codePoints = (value: string): number => [...value].length;
const normalizeBody = (value: string): string => normalizeLines(value).trim().replace(/\s+/gu, " ").toLocaleLowerCase();

const rejectUnsafeText = (value: string): void => {
  try {
    assertSafeText(value);
  } catch {
    throw new LocalBrainError("secret_rejected", "proposal contains unsafe text");
  }
};

const validateEvidence = (evidence: MemoryEvidence[]): MemoryEvidence[] => {
  if (evidence.length === 0 || evidence.length > 20) {
    throw new LocalBrainError("proposal_invalid", "proposal evidence must contain 1 to 20 entries");
  }
  return evidence.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !EVIDENCE_KINDS.has(item.kind) ||
      typeof item.ref !== "string" ||
      item.ref.trim() === ""
    ) {
      throw new LocalBrainError("proposal_invalid", "proposal evidence is invalid");
    }
    const ref = normalizeLines(item.ref).trim();
    if (codePoints(ref) > 500 || isAbsolute(ref) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(ref)) {
      throw new LocalBrainError("proposal_invalid", "proposal evidence must be repository-relative");
    }
    rejectUnsafeText(ref);
    return { kind: item.kind, ref };
  });
};

export const validateProposalInput = (input: LocalMemoryProposalInput): LocalMemoryProposalInput => {
  const unknownKeys = Object.keys(input).filter(
    (key) => !["projectRoot", "section", "title", "summary", "evidence", "replace"].includes(key),
  );
  if (unknownKeys.length > 0) {
    const message = unknownKeys.some((key) => /transcript|session|prompt|reasoning/iu.test(key))
      ? "proposal cannot contain transcript fields"
      : "proposal contains unknown fields";
    throw new LocalBrainError("proposal_invalid", message);
  }
  if (!SECTIONS.has(input.section) || typeof input.title !== "string" || typeof input.summary !== "string") {
    throw new LocalBrainError("proposal_invalid", "proposal fields are invalid");
  }

  const title = normalizeLines(input.title).trim();
  const summary = normalizeLines(input.summary).trim();
  if (codePoints(title) === 0 || codePoints(title) > 80 || codePoints(summary) === 0 || codePoints(summary) > 1_000) {
    throw new LocalBrainError("proposal_invalid", "proposal title or summary exceeds its bound");
  }
  rejectUnsafeText(title);
  rejectUnsafeText(summary);
  if (!Array.isArray(input.evidence)) throw new LocalBrainError("proposal_invalid", "proposal evidence is invalid");

  if (input.replace !== undefined) {
    if (
      typeof input.replace.title !== "string" ||
      input.replace.title.trim() === "" ||
      !/^[a-f0-9]{64}$/u.test(input.replace.contentHash)
    ) {
      throw new LocalBrainError("proposal_invalid", "replacement target is invalid");
    }
  }

  return {
    projectRoot: input.projectRoot,
    section: input.section,
    title,
    summary,
    evidence: validateEvidence(input.evidence),
    ...(input.replace === undefined
      ? {}
      : { replace: { title: normalizeLines(input.replace.title).trim(), contentHash: input.replace.contentHash } }),
  };
};

export const renderEntry = (
  input: Omit<LocalMemoryProposalInput, "projectRoot" | "replace">,
  addedOn: string,
): string =>
  [
    `### ${input.title}`,
    "",
    input.summary,
    "",
    ...input.evidence.map((evidence) => `- Evidence: \`${evidence.ref}\``),
    `- Added: ${addedOn}`,
    "",
  ].join("\n");

const unifiedPatch = (before: string, after: string): string => {
  if (before === after) return "";
  const beforeLines = before.endsWith("\n") ? before.slice(0, -1).split("\n") : before.split("\n");
  const afterLines = after.endsWith("\n") ? after.slice(0, -1).split("\n") : after.split("\n");
  return [
    "--- a/.agents/memory.md",
    "+++ b/.agents/memory.md",
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    "",
  ].join("\n");
};

type EntryMatch = { title: string; content: string; contentHash: string; startLine: number };

const sectionEntries = (document: LocalMemoryDocument, section: LocalMemorySection): EntryMatch[] =>
  document.chunks
    .filter((chunk) => chunk.headingPath.length === 2 && chunk.headingPath[0] === section)
    .map((chunk) => ({
      title: chunk.headingPath[1] ?? "",
      content: chunk.content,
      contentHash: chunk.contentHash,
      startLine: chunk.startLine,
    }));

const sectionExists = (document: LocalMemoryDocument, section: LocalMemorySection): boolean =>
  document.text.split("\n").some((line) => line.trim() === `## ${section}`);

const appendToSection = (document: LocalMemoryDocument, section: LocalMemorySection, entry: string): string => {
  const lines = document.text.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (headingIndex === -1) throw new LocalBrainError("proposal_conflict", "target memory section is unavailable");
  let insertAt = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index] ?? "")) {
      insertAt = index;
      break;
    }
  }
  const prefix = lines.slice(0, insertAt).join("\n").replace(/\s*$/u, "");
  const suffix = lines.slice(insertAt).join("\n").replace(/^\s*/u, "");
  return `${prefix}\n\n${entry}${suffix === "" ? "" : `\n\n${suffix}`}`.replace(/\n*$/u, "\n");
};

const replaceEntry = (document: LocalMemoryDocument, entry: EntryMatch, replacement: string): string => {
  const lines = document.text.split("\n");
  const headingIndex = entry.startLine - 2;
  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^#{2,3}\s+/u.test(lines[index] ?? "")) {
      endIndex = index;
      break;
    }
  }
  return `${lines.slice(0, headingIndex).join("\n").replace(/\s*$/u, "")}\n\n${replacement}${lines
    .slice(endIndex)
    .join("\n")
    .replace(/^\s*/u, "")}`.replace(/\n*$/u, "\n");
};

export type BuiltProposal = LocalMemoryProposal & { nextText?: string; renderedEntry: string };

export const buildProposal = (
  rawInput: LocalMemoryProposalInput,
  document: LocalMemoryDocument,
  addedOn: string,
): BuiltProposal => {
  const input = validateProposalInput(rawInput);
  if (!sectionExists(document, input.section)) {
    throw new LocalBrainError("proposal_conflict", "target memory section is unavailable");
  }

  const entry = renderEntry(input, addedOn);
  const currentEntries = sectionEntries(document, input.section);
  const sameTitle = currentEntries.filter((current) => normalizeTitle(current.title) === normalizeTitle(input.title));
  let action: ProposalAction = "add";
  let nextText: string | undefined;
  if (input.replace !== undefined) {
    const replacement = currentEntries.find(
      (current) =>
        normalizeTitle(current.title) === normalizeTitle(input.replace?.title ?? "") &&
        current.contentHash === input.replace?.contentHash,
    );
    if (replacement === undefined) action = "needs_resolution";
    else {
      action = "replace";
      nextText = replaceEntry(document, replacement, entry);
    }
  } else if (
    sameTitle.some((current) => normalizeBody(current.content) === normalizeBody(entry.slice(entry.indexOf("\n") + 1)))
  ) {
    action = "no_change";
  } else if (sameTitle.length > 0) {
    action = "needs_resolution";
  } else {
    const titleTokens = new Set(normalizeTitle(input.title).split(/\s+/u));
    const ambiguous = currentEntries.some((current) => {
      const candidate = new Set(normalizeTitle(current.title).split(/\s+/u));
      const overlap = [...titleTokens].filter((token) => candidate.has(token)).length;
      return overlap >= 2 && overlap / Math.max(titleTokens.size, candidate.size) >= 0.7;
    });
    if (ambiguous) action = "needs_resolution";
    else nextText = appendToSection(document, input.section, entry);
  }

  const patch = nextText === undefined ? "" : unifiedPatch(document.text, nextText);
  const proposalId = sha256(
    JSON.stringify({
      schemaVersion: 1,
      baseContentHash: document.contentHash,
      action,
      section: input.section,
      title: input.title,
      summary: input.summary,
      evidence: input.evidence,
      renderedEntry: action === "add" || action === "replace" ? entry : "",
    }),
  );
  return {
    proposalId,
    baseContentHash: document.contentHash,
    section: input.section,
    title: input.title,
    summary: input.summary,
    evidence: input.evidence,
    action,
    patch,
    warnings: [],
    renderedEntry: entry,
    ...(nextText === undefined ? {} : { nextText }),
  };
};
