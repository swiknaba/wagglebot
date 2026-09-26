import { mkdirSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { assertInside, LocalBrainError } from "../path-policy";
import type { LocalMemoryBundle, LocalMemoryPath } from "../types";
import { loadMemoryBundle } from "./bundle";
import { renderMemoryIndexes } from "./indexes";
import { writeMemoryAtomically } from "./write";

const BUNDLE_PATH = ".agents/memory" as const;
export const INITIAL_COMPONENT_PATH = ".agents/memory/component.md" as const;

const INITIAL_COMPONENT = `---
type: Component Overview
title: Component overview
description: Repository purpose, boundaries, and ownership.
status: draft
tags: [component]
---

# Component Overview

Replace this draft with the repository's purpose, boundaries, and ownership.
`;

const internalError = (): never => {
  throw new LocalBrainError("local_brain_internal", "local memory bundle could not be updated");
};

const bundleFile = (projectRoot: string, path: LocalMemoryPath): string => {
  const segments = path.split("/");
  if (
    !path.startsWith(`${BUNDLE_PATH}/`) ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new LocalBrainError("local_memory_invalid", "local memory index path is invalid");
  }
  const target = resolve(projectRoot, ...segments);
  assertInside(projectRoot, target);
  return target;
};

export const repairMemoryIndexes = (
  projectRoot: string,
  bundle: LocalMemoryBundle,
  write: (target: string, content: string) => void = writeMemoryAtomically,
): LocalMemoryBundle => {
  const expected = renderMemoryIndexes(bundle.concepts);
  const existing = new Map(bundle.indexes.map(({ path, text }) => [path, text]));

  try {
    for (const [path, content] of expected) {
      if (existing.get(path) === content) continue;
      write(bundleFile(projectRoot, path), content);
    }

    for (const { path } of bundle.indexes) {
      if (basename(path) !== "index.md" || expected.has(path)) continue;
      unlinkSync(bundleFile(projectRoot, path));
    }
  } catch (error) {
    if (error instanceof LocalBrainError) throw error;
    internalError();
  }

  const refreshed = loadMemoryBundle(projectRoot);
  if (refreshed === undefined || refreshed.indexState !== "current") return internalError();
  return refreshed;
};

export const ensureLocalMemoryBundle = (projectRoot: string): LocalMemoryBundle => {
  let bundle = loadMemoryBundle(projectRoot);
  if (bundle === undefined) {
    const memoryRoot = join(projectRoot, ".agents", "memory");
    try {
      mkdirSync(memoryRoot, { recursive: true });
      writeMemoryAtomically(join(projectRoot, INITIAL_COMPONENT_PATH), INITIAL_COMPONENT);
    } catch {
      internalError();
    }
    bundle = loadMemoryBundle(projectRoot);
    if (bundle === undefined) return internalError();
  }
  return repairMemoryIndexes(projectRoot, bundle);
};
