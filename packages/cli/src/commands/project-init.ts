import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "../project-root";
import type { Reporter } from "../report";
import { PROJECT_INSTRUCTIONS_DIR, runProjectUpdate } from "./project-update";

export function runProjectInit(input: { cwd: string; reporter: Reporter }): number {
  const root = findProjectRoot(input.cwd);
  mkdirSync(join(root, PROJECT_INSTRUCTIONS_DIR), { recursive: true });
  return runProjectUpdate({ cwd: root, reporter: input.reporter });
}
