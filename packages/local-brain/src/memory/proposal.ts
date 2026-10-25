import { createHash } from "node:crypto";
import { posix } from "node:path";
import { LocalMemoryConceptPathSchema } from "@wagglebot/contracts";
import { assertSafeText } from "@wagglebot/secret-scanner";
import { stringify } from "yaml";

import { LocalBrainError } from "../path-policy";
import type {
  LocalMemoryBundle,
  LocalMemoryConcept,
  LocalMemoryIndexChange,
  LocalMemoryPath,
  LocalMemoryProposal,
  LocalMemoryProposalInput,
  LocalMemorySection,
  MemoryEvidence,
} from "../types";
import { renderMemoryIndexes } from "./indexes";
import { parseConcept } from "./parse";

const CATEGORY = {
  Architecture: ["architecture", "Architecture"],
  Conventions: ["conventions", "Convention"],
  Commands: ["commands", "Command"],
  Decisions: ["decisions", "Decision"],
  Warnings: ["warnings", "Warning"],
  Learnings: ["learnings", "Learning"],
} as const;

const SECTIONS = new Set<LocalMemorySection>(Object.keys(CATEGORY) as LocalMemorySection[]);
const EVIDENCE_KINDS = new Set<MemoryEvidence["kind"]>([
  "file",
  "commit",
  "adr",
  "issue",
  "test",
  "maintainer_confirmation",
]);
const MAX_BUNDLE_BYTES = 256 * 1024;
const CONCEPT_PREFIX = ".agents/memory/";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const codePoints = (value: string): number => [...value].length;
const normalizeLines = (value: string): string => value.replace(/\r\n?/gu, "\n");
const hasLineBreak = (value: string): boolean => /[\r\n]/u.test(value);
const normalizeTitle = (value: string): string => value.trim().toLowerCase();
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const rejectUnsafeText = (value: string): void => {
  try {
    assertSafeText(value);
  } catch {
    throw new LocalBrainError("secret_rejected", "proposal contains unsafe text");
  }
};

const safeRelativeRef = (value: string): boolean => {
  if (value === "" || value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:/u.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

const validConceptPath = (value: unknown): value is LocalMemoryPath => {
  return (
    typeof value === "string" && value.split("/").length >= 3 && LocalMemoryConceptPathSchema.safeParse(value).success
  );
};

const validateEvidence = (value: unknown): MemoryEvidence[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new LocalBrainError("proposal_invalid", "proposal evidence must contain 1 to 20 entries");
  }
  return value.map((item) => {
    const entry = item as Record<string, unknown> | null;
    if (
      typeof entry !== "object" ||
      entry === null ||
      Object.keys(entry).some((key) => key !== "kind" && key !== "ref") ||
      !EVIDENCE_KINDS.has(entry.kind as MemoryEvidence["kind"]) ||
      typeof entry.ref !== "string"
    ) {
      throw new LocalBrainError("proposal_invalid", "proposal evidence is invalid");
    }
    const ref = normalizeLines(entry.ref).trim();
    if (hasLineBreak(ref) || codePoints(ref) > 500 || !safeRelativeRef(ref)) {
      throw new LocalBrainError("proposal_invalid", "proposal evidence must be a safe relative reference");
    }
    rejectUnsafeText(ref);
    return { kind: entry.kind as MemoryEvidence["kind"], ref };
  });
};

export const validateProposalInput = (raw: LocalMemoryProposalInput): LocalMemoryProposalInput => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LocalBrainError("proposal_invalid", "proposal fields are invalid");
  }
  const unknownKeys = Object.keys(raw).filter(
    (key) => !["projectRoot", "section", "title", "summary", "evidence", "replace"].includes(key),
  );
  if (unknownKeys.length > 0) {
    const message = unknownKeys.some((key) => /transcript|session|prompt|reasoning/iu.test(key))
      ? "proposal cannot contain transcript fields"
      : "proposal contains unknown fields";
    throw new LocalBrainError("proposal_invalid", message);
  }
  if (
    typeof raw.projectRoot !== "string" ||
    !SECTIONS.has(raw.section) ||
    typeof raw.title !== "string" ||
    typeof raw.summary !== "string"
  ) {
    throw new LocalBrainError("proposal_invalid", "proposal fields are invalid");
  }
  if (hasLineBreak(raw.title) || hasLineBreak(raw.summary)) {
    throw new LocalBrainError("proposal_invalid", "proposal title and summary must be one line");
  }
  const title = normalizeLines(raw.title).trim();
  const summary = normalizeLines(raw.summary).trim();
  if (title.startsWith("#") || summary.startsWith("#")) {
    throw new LocalBrainError("proposal_invalid", "proposal title and summary must not start with a Markdown heading");
  }
  if (codePoints(title) < 1 || codePoints(title) > 80 || codePoints(summary) < 1 || codePoints(summary) > 1_000) {
    throw new LocalBrainError("proposal_invalid", "proposal title or summary exceeds its bound");
  }
  rejectUnsafeText(title);
  rejectUnsafeText(summary);

  let replace: LocalMemoryProposalInput["replace"];
  if (raw.replace !== undefined) {
    if (
      typeof raw.replace !== "object" ||
      raw.replace === null ||
      Object.keys(raw.replace).some((key) => key !== "path" && key !== "contentHash") ||
      !validConceptPath(raw.replace.path) ||
      !raw.replace.path.startsWith(`${CONCEPT_PREFIX}${CATEGORY[raw.section][0]}/`) ||
      typeof raw.replace.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.replace.contentHash)
    ) {
      throw new LocalBrainError("proposal_invalid", "replacement target is invalid");
    }
    replace = { path: raw.replace.path, contentHash: raw.replace.contentHash };
  }

  return {
    projectRoot: raw.projectRoot,
    section: raw.section,
    title,
    summary,
    evidence: validateEvidence(raw.evidence),
    ...(replace === undefined ? {} : { replace }),
  };
};

const slugFor = (title: string): string =>
  title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

const sourceFor = (evidence: MemoryEvidence, path: LocalMemoryPath, index: number) => {
  const fileEvidence = evidence.kind === "file" || evidence.kind === "adr";
  const lineMatch = fileEvidence ? /:(\d+)$/u.exec(evidence.ref) : null;
  const line = lineMatch === null ? undefined : Number(lineMatch[1]);
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) {
    throw new LocalBrainError("proposal_invalid", "evidence line number is invalid");
  }
  let resource: string;
  if (fileEvidence) {
    const sourcePath = lineMatch === null ? evidence.ref : evidence.ref.slice(0, -lineMatch[0].length);
    if (!safeRelativeRef(sourcePath)) throw new LocalBrainError("proposal_invalid", "evidence path is invalid");
    const conceptDirectory = posix.dirname(path);
    resource = posix.relative(conceptDirectory, sourcePath);
    if (line !== undefined) resource += `#L${line}`;
  } else {
    resource = `${evidence.kind}:${evidence.ref}`;
  }
  return {
    id: `evidence-${index + 1}`,
    resource,
    title: evidence.ref,
    kind: evidence.kind,
  };
};

const renderConcept = (
  input: Omit<LocalMemoryProposalInput, "projectRoot" | "replace">,
  path: LocalMemoryPath,
  previous?: LocalMemoryConcept,
): string => {
  const [, type] = CATEGORY[input.section];
  const sources = input.evidence.map((item, index) => sourceFor(item, path, index));
  const metadata: Record<string, unknown> = {
    ...(previous?.frontmatter ?? {}),
    type,
    title: input.title,
    description: input.summary,
    tags: [type.toLowerCase()],
    status: "stable",
    sources,
  };
  const frontmatter = stringify(metadata, { lineWidth: 0 }).trimEnd();
  const footnoteMarkers = input.evidence.map((_, index) => `[^evidence-${index + 1}]`).join("");
  const footnotes = input.evidence.map((item, index) => `[^evidence-${index + 1}]: \`${item.ref}\``).join("\n");
  return `---\n${frontmatter}\n---\n\n# ${type}\n\n${input.summary}${footnoteMarkers}\n\n${footnotes}\n`;
};

const normalizedText = (text: string): string => text.replace(/\r\n?/gu, "\n");
const lines = (text: string): string[] => {
  const normalized = normalizedText(text);
  return normalized === "" ? [] : (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
};

const filePatch = (path: string, before: string, after: string): string => {
  if (before === after) return "";
  const oldLines = lines(before);
  const newLines = lines(after);
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  return [
    `--- a/${path}`,
    `+++ ${newLines.length === 0 ? "/dev/null" : `b/${path}`}`,
    `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
};

const canonical = (value: unknown): string => {
  const sortValue = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sortValue);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => compare(left, right))
          .map(([key, child]) => [key, sortValue(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(sortValue(value));
};

export const proposalIdFor = (proposal: Omit<LocalMemoryProposal, "proposalId"> | LocalMemoryProposal): string => {
  const { proposalId: _proposalId, ...fields } = proposal as LocalMemoryProposal;
  return sha256(canonical(fields));
};

const indexChangesFor = (
  bundle: LocalMemoryBundle,
  generatedIndexes: Map<LocalMemoryPath, string>,
): LocalMemoryIndexChange[] => {
  const current = new Map(bundle.indexes.map(({ path, text }) => [path, text]));
  return [...generatedIndexes]
    .filter(([path, content]) => current.get(path) !== content)
    .map(([path, content]) => ({ path, content }))
    .sort((left, right) => compare(left.path, right.path));
};

const semanticDuplicate = (left: LocalMemoryConcept, right: LocalMemoryConcept): boolean =>
  left.type === right.type &&
  left.title === right.title &&
  left.description === right.description &&
  canonical(left.tags) === canonical(right.tags) &&
  canonical(left.frontmatter.sources) === canonical(right.frontmatter.sources) &&
  left.frontmatter.status === right.frontmatter.status &&
  left.body === right.body;

export const buildProposal = (rawInput: LocalMemoryProposalInput, bundle: LocalMemoryBundle): LocalMemoryProposal => {
  const input = validateProposalInput(rawInput);
  const [category] = CATEGORY[input.section];
  const slug = slugFor(input.title);
  if (input.replace === undefined && slug === "") {
    throw new LocalBrainError("proposal_invalid", "proposal title does not produce a usable filename");
  }
  const path = input.replace?.path ?? (`${CONCEPT_PREFIX}${category}/${slug}.md` as LocalMemoryPath);
  const previous = bundle.concepts.find((concept) => concept.path === path);
  const content = renderConcept(
    { section: input.section, title: input.title, summary: input.summary, evidence: input.evidence },
    path,
    input.replace === undefined ? undefined : previous,
  );
  rejectUnsafeText(content);
  let parsed: LocalMemoryConcept;
  try {
    parsed = parseConcept(content, path);
  } catch {
    throw new LocalBrainError("proposal_invalid", "proposal would produce an invalid concept");
  }

  const sameTitle = bundle.concepts.filter((concept) => normalizeTitle(concept.title) === normalizeTitle(input.title));
  let action: LocalMemoryProposal["action"];
  if (input.replace !== undefined) {
    const selected = bundle.concepts.find(
      (concept) => concept.path === input.replace?.path && concept.contentHash === input.replace?.contentHash,
    );
    const conflict = sameTitle.some((concept) => concept.path !== input.replace?.path);
    action = selected === undefined || conflict ? "needs_resolution" : "replace";
  } else if (sameTitle.length > 0) {
    const exactDuplicate = sameTitle.every((concept) => semanticDuplicate(concept, parsed));
    const targetIsConflict = previous !== undefined && !semanticDuplicate(previous, parsed);
    action = exactDuplicate && !targetIsConflict ? "no_change" : "needs_resolution";
  } else if (previous !== undefined) {
    action = "needs_resolution";
  } else {
    action = "add";
  }

  let indexChanges: LocalMemoryIndexChange[] = [];
  let patch = "";
  if (action === "add" || action === "replace") {
    const concepts = bundle.concepts.filter((concept) => concept.path !== path).concat(parsed);
    const generatedIndexes = renderMemoryIndexes(concepts);
    indexChanges = indexChangesFor(bundle, generatedIndexes);
    const before = new Map<string, string>([
      ...bundle.concepts.map((concept) => [concept.path, concept.text] as const),
      ...bundle.indexes.map((index) => [index.path, index.text] as const),
    ]);
    const patchFiles = [
      { path, before: before.get(path) ?? "", after: content },
      ...indexChanges.map((change) => ({
        path: change.path,
        before: before.get(change.path) ?? "",
        after: change.content,
      })),
      ...bundle.indexes
        .filter(({ path: indexPath }) => !generatedIndexes.has(indexPath))
        .map((index) => ({ path: index.path, before: index.text, after: "" })),
    ];
    patch = patchFiles
      .sort((left, right) => compare(left.path, right.path))
      .map((change) => filePatch(change.path, change.before, change.after))
      .filter(Boolean)
      .join("\n");
  }

  const fields: Omit<LocalMemoryProposal, "proposalId"> = {
    baseBundleHash: bundle.bundleHash,
    path,
    section: input.section,
    title: input.title,
    summary: input.summary,
    evidence: input.evidence,
    ...(input.replace === undefined ? {} : { replace: input.replace }),
    action,
    content,
    indexChanges,
    patch,
    warnings: [],
  };
  return { proposalId: proposalIdFor(fields), ...fields };
};

export const verifyProposal = (value: unknown): value is LocalMemoryProposal => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proposal = value as Record<string, unknown>;
  const allowed = new Set([
    "proposalId",
    "baseBundleHash",
    "path",
    "section",
    "title",
    "summary",
    "evidence",
    "replace",
    "action",
    "content",
    "indexChanges",
    "patch",
    "warnings",
  ]);
  if (Object.keys(proposal).some((key) => !allowed.has(key))) return false;
  if (
    typeof proposal.proposalId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proposal.proposalId) ||
    typeof proposal.baseBundleHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proposal.baseBundleHash) ||
    !validConceptPath(proposal.path) ||
    typeof proposal.section !== "string" ||
    !SECTIONS.has(proposal.section as LocalMemorySection) ||
    typeof proposal.title !== "string" ||
    typeof proposal.summary !== "string" ||
    typeof proposal.content !== "string" ||
    typeof proposal.patch !== "string" ||
    !Array.isArray(proposal.warnings) ||
    !proposal.warnings.every((warning) => typeof warning === "string") ||
    !Array.isArray(proposal.indexChanges) ||
    !["add", "replace", "no_change", "needs_resolution"].includes(String(proposal.action))
  )
    return false;
  const validIndexPath = (path: unknown): path is LocalMemoryPath => {
    if (typeof path !== "string" || !path.startsWith(CONCEPT_PREFIX) || path.includes("\\")) return false;
    const segments = path.split("/");
    return (
      segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
      (path === `${CONCEPT_PREFIX}index.md` || path.endsWith("/index.md"))
    );
  };
  if (
    !proposal.indexChanges.every((change) => {
      if (typeof change !== "object" || change === null || Array.isArray(change)) return false;
      const candidate = change as Record<string, unknown>;
      return (
        Object.keys(candidate).every((key) => key === "path" || key === "content") &&
        validIndexPath(candidate.path) &&
        typeof candidate.content === "string"
      );
    })
  )
    return false;
  try {
    validateProposalInput({
      projectRoot: "/repo",
      section: proposal.section as LocalMemorySection,
      title: proposal.title,
      summary: proposal.summary,
      evidence: proposal.evidence as MemoryEvidence[],
      ...(proposal.replace === undefined ? {} : { replace: proposal.replace as LocalMemoryProposalInput["replace"] }),
    });
  } catch {
    return false;
  }
  const { proposalId, ...fields } = proposal;
  return proposalIdFor(fields as Omit<LocalMemoryProposal, "proposalId">) === proposalId;
};

export const canonicalProposalValue = canonical;

export const assertProjectedBundleSize = (
  bundle: LocalMemoryBundle,
  proposal: LocalMemoryProposal,
  concepts: LocalMemoryConcept[],
): void => {
  const oldConcept = bundle.concepts.find(({ path }) => path === proposal.path);
  let projected = bundle.totalBytes - (oldConcept === undefined ? 0 : Buffer.byteLength(oldConcept.text, "utf8"));
  projected += Buffer.byteLength(proposal.content, "utf8");
  if (projected > MAX_BUNDLE_BYTES)
    throw new LocalBrainError("local_memory_too_large", "local memory bundle exceeds 256 KiB");

  const expected = renderMemoryIndexes(concepts);
  const existing = new Map(bundle.indexes.map(({ path, text }) => [path, text]));
  for (const [path, content] of expected) {
    if (existing.get(path) === content) continue;
    projected -= Buffer.byteLength(existing.get(path) ?? "", "utf8");
    projected += Buffer.byteLength(content, "utf8");
    if (projected > MAX_BUNDLE_BYTES)
      throw new LocalBrainError("local_memory_too_large", "local memory bundle exceeds 256 KiB");
  }
};
