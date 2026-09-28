import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureLocalMemoryBundle } from "@wagglebot/local-brain";
import { writeFileAtomic } from "../atomic-write";
import { findProjectRoot } from "../project-root";

export type BrainInit = {
  identify(projectPath: string): Promise<unknown>;
  code: { initialize?: (projectPath: string) => Promise<unknown> };
  close?: () => Promise<void>;
};

const BEGIN = "# wagglebot:begin local-brain";
const END = "# wagglebot:end local-brain";

const hasEffectiveIgnore = (text: string): boolean =>
  text.split("\n").some((line) => {
    const value = line.trim();
    return value !== "" && !value.startsWith("#") && !value.startsWith("!") && /^\.codegraph\/?$/u.test(value);
  });

const ensureIgnore = (root: string): void => {
  const target = join(root, ".gitignore");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (existing.includes(BEGIN) && existing.includes(END)) return;
  if (hasEffectiveIgnore(existing)) return;
  const separator = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileAtomic(target, `${existing}${separator}${BEGIN}\n.codegraph/\n${END}\n`);
};

export async function runBrainInit(input: {
  projectPath: string;
  brain: BrainInit;
  write: (line: string) => void;
}): Promise<number> {
  const root = findProjectRoot(input.projectPath);
  try {
    ensureLocalMemoryBundle(root);
    ensureIgnore(root);
    const identity = await input.brain.identify(root);
    if (input.brain.code.initialize === undefined) throw new Error("CodeGraph initialization is unavailable");
    const graph = await input.brain.code.initialize(root);
    input.write(`Component memory  ready  .agents/memory/`);
    input.write(`Code graph         ${(graph as { state?: string }).state ?? "ready"}`);
    input.write(`Component identity ${JSON.stringify(identity)}`);
    return 0;
  } catch (error) {
    input.write(`brain init: ${error instanceof Error ? error.message : "initialization failed"}`);
    return 1;
  } finally {
    await input.brain.close?.();
  }
}
