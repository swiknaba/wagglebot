import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseDocument } from "yaml";

import { assertInside, LocalBrainError } from "../path-policy";
import type { LocalMemoryBundle, LocalMemoryConcept, LocalMemoryPath, LocalMemoryReservedFile } from "../types";
import { renderMemoryIndexes } from "./indexes";
import { MemoryParseError, parseConcept } from "./parse";

const BUNDLE_PATH = ".agents/memory" as const;
const UNSUPPORTED_MEMORY_FILE = ".agents/memory.md" as const;
const MAX_BUNDLE_BYTES = 256 * 1024;

type FileRecord = {
  relativePath: string;
  bytes: Buffer;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const localMemoryInvalid = (message: string): never => {
  throw new LocalBrainError("local_memory_invalid", message);
};

const localMemoryUnavailable = (): never => {
  throw new LocalBrainError("local_brain_internal", "local memory bundle is unavailable");
};

const canonicalRoot = (projectRoot: string): string => {
  try {
    return realpathSync(projectRoot);
  } catch {
    throw new LocalBrainError("project_not_found", "Git repository is unavailable");
  }
};

const lstatOrMissing = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    return localMemoryUnavailable();
  }
};

const assertNoLegacyMemory = (projectRoot: string): void => {
  const legacyPath = join(projectRoot, UNSUPPORTED_MEMORY_FILE);
  if (lstatOrMissing(legacyPath) !== undefined) {
    localMemoryInvalid(`legacy memory file is unsupported; use ${BUNDLE_PATH}/`);
  }
};

const normalizedRelativePath = (bundleRoot: string, filePath: string): string =>
  relative(bundleRoot, filePath).split(sep).join("/");

const traverseMarkdown = (bundleRoot: string): FileRecord[] => {
  const records: FileRecord[] = [];
  let totalBytes = 0;

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const stat = lstatOrMissing(absolutePath);
      if (stat === undefined) continue;
      if (stat.isSymbolicLink()) {
        throw new LocalBrainError("path_outside_repository", "local memory contains a symbolic link");
      }
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) localMemoryInvalid("local memory contains an unsupported file");
      if (!entry.name.endsWith(".md")) continue;

      const relativePath = normalizedRelativePath(bundleRoot, absolutePath);
      let bytes: Buffer;
      try {
        bytes = readFileSync(absolutePath);
      } catch {
        throw new LocalBrainError("local_brain_internal", "local memory bundle is unavailable");
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_BUNDLE_BYTES) {
        throw new LocalBrainError("local_memory_too_large", "local memory bundle exceeds 256 KiB");
      }
      records.push({ relativePath, bytes });
    }
  };

  visit(bundleRoot);
  return records.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
};

const validateDateHeading = (heading: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(heading)) return false;
  const date = new Date(`${heading}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === heading;
};

const validateLog = (text: string, relativePath: string): void => {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  let hasHeading = false;
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fenceMatch?.[1] !== undefined) {
      const run = fenceMatch[1];
      const marker = run[0] as "`" | "~";
      if (fence === undefined) fence = { marker, length: run.length };
      else if (marker === fence.marker && run.length >= fence.length && /^\s*$/u.test(fenceMatch[2] ?? "")) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;

    if (/^ {0,3}#\s+\S/u.test(line)) hasHeading = true;
    const h2 = /^ {0,3}##[ \t]+(.+?)\s*#*\s*$/u.exec(line);
    if (h2?.[1] !== undefined && !validateDateHeading(h2[1].trim())) {
      localMemoryInvalid(`local memory log is invalid: ${relativePath}`);
    }
  }
  if (!hasHeading) localMemoryInvalid(`local memory log is invalid: ${relativePath}`);
};

const validateRootIndex = (text: string, relativePath: string): void => {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") localMemoryInvalid(`local memory index is invalid: ${relativePath}`);
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing < 0) localMemoryInvalid(`local memory index is invalid: ${relativePath}`);

  const document = (() => {
    try {
      return parseDocument(lines.slice(1, closing).join("\n"));
    } catch {
      return localMemoryInvalid(`local memory index is invalid: ${relativePath}`);
    }
  })();
  if (document.errors.length > 0) localMemoryInvalid(`local memory index is invalid: ${relativePath}`);

  let value: unknown;
  try {
    value = document.toJS();
  } catch {
    localMemoryInvalid(`local memory index is invalid: ${relativePath}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    localMemoryInvalid(`local memory index is invalid: ${relativePath}`);
  }
  if ((value as Record<string, unknown>).okf_version !== "0.2") {
    localMemoryInvalid(`local memory index is invalid: ${relativePath}`);
  }
};

const validateCategoryIndex = (text: string, relativePath: string): void => {
  if (
    text
      .replace(/^\uFEFF/u, "")
      .replace(/\r\n?/gu, "\n")
      .split("\n", 1)[0] === "---"
  ) {
    localMemoryInvalid(`local memory index is invalid: ${relativePath}`);
  }
};

const asReservedFile = (relativePath: string, bytes: Buffer): LocalMemoryReservedFile => {
  const path = `${BUNDLE_PATH}/${relativePath}` as LocalMemoryPath;
  const text = bytes.toString("utf8");
  if (text.includes("\0") || text.includes("\uFFFD")) {
    localMemoryInvalid(`local memory file is invalid: ${relativePath}`);
  }
  if (relativePath === "index.md") validateRootIndex(text, relativePath);
  else if (relativePath.endsWith("/index.md")) validateCategoryIndex(text, relativePath);
  else validateLog(text, relativePath);
  return { path, text, contentHash: sha256(text) };
};

const expectedIndexState = (
  concepts: LocalMemoryConcept[],
  indexes: LocalMemoryReservedFile[],
): LocalMemoryBundle["indexState"] => {
  if (indexes.length === 0) return "missing";
  const expected = renderMemoryIndexes(concepts);
  if (expected.size !== indexes.length) return "stale";
  const actual = new Map(indexes.map(({ path, text }) => [path, text]));
  for (const [path, text] of expected) {
    if (actual.get(path) !== text) return "stale";
  }
  return "current";
};

const loadAtRoot = (projectRoot: string): LocalMemoryBundle | undefined => {
  const root = canonicalRoot(projectRoot);
  const agentsRoot = join(root, ".agents");
  const agentsStat = lstatOrMissing(agentsRoot);
  if (agentsStat === undefined) return undefined;
  if (agentsStat.isSymbolicLink()) {
    throw new LocalBrainError("path_outside_repository", "local memory contains a symbolic link");
  }
  if (!agentsStat.isDirectory()) localMemoryInvalid(".agents is not a directory");
  assertNoLegacyMemory(root);

  const bundleRootPath = join(agentsRoot, "memory");
  const bundleStat = lstatOrMissing(bundleRootPath);
  if (bundleStat === undefined) return undefined;
  if (bundleStat.isSymbolicLink()) {
    throw new LocalBrainError("path_outside_repository", "local memory contains a symbolic link");
  }
  if (!bundleStat.isDirectory()) localMemoryInvalid(`${BUNDLE_PATH} is not a directory`);

  const bundleRoot = realpathSync(bundleRootPath);
  assertInside(root, bundleRoot);
  const records = traverseMarkdown(bundleRoot);
  const totalBytes = records.reduce((total, record) => total + record.bytes.byteLength, 0);
  if (totalBytes > MAX_BUNDLE_BYTES) {
    throw new LocalBrainError("local_memory_too_large", "local memory bundle exceeds 256 KiB");
  }

  const concepts: LocalMemoryConcept[] = [];
  const indexes: LocalMemoryReservedFile[] = [];
  const logs: LocalMemoryReservedFile[] = [];
  for (const record of records) {
    const basename = record.relativePath.split("/").at(-1);
    if (basename === "index.md") {
      indexes.push(asReservedFile(record.relativePath, record.bytes));
      continue;
    }
    if (basename === "log.md") {
      logs.push(asReservedFile(record.relativePath, record.bytes));
      continue;
    }

    const path = `${BUNDLE_PATH}/${record.relativePath}` as LocalMemoryPath;
    try {
      concepts.push(parseConcept(record.bytes.toString("utf8"), path));
    } catch (error) {
      if (error instanceof MemoryParseError) {
        localMemoryInvalid(`local memory concept is invalid: ${record.relativePath}`);
      }
      if (error instanceof LocalBrainError) throw error;
      localMemoryInvalid(`local memory concept is invalid: ${record.relativePath}`);
    }
  }

  concepts.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
  indexes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  logs.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const conceptPairs = concepts.map((concept) => `${concept.relativePath}\0${concept.contentHash}`).sort();
  const bundleHash = sha256(conceptPairs.join("\0"));

  return {
    path: BUNDLE_PATH,
    concepts,
    indexes,
    logs,
    bundleHash,
    totalBytes,
    indexState: expectedIndexState(concepts, indexes),
  };
};

export const loadMemoryBundle = (projectRoot: string): LocalMemoryBundle | undefined => {
  try {
    return loadAtRoot(projectRoot);
  } catch (error) {
    if (error instanceof LocalBrainError) throw error;
    return localMemoryUnavailable();
  }
};
