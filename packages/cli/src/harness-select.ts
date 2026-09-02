import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec";
import { HARNESSES, type Harness } from "./harness";

export const HARNESS_CONFIG_KEY = "wagglebot.harnesses";

const valid = () => HARNESSES.map((h) => h.name).join(", ");

// Which harnesses this workstation provisions. An explicit list in the global git config wins.
// Otherwise every harness whose home directory exists is selected, so a machine without
// Junie never gets a ~/.junie directory.
export async function selectHarnesses(
  home: string,
  exec: Exec,
): Promise<{ harnesses: Harness[]; source: "config" | "detected" }> {
  const stored = await exec("git", ["config", "--global", HARNESS_CONFIG_KEY]);
  const names = stored.stdout
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  if (names.length > 0) {
    const unknown = names.filter((n) => !HARNESSES.some((h) => h.name === n));
    if (unknown.length > 0) {
      throw new Error(
        `git config ${HARNESS_CONFIG_KEY} names an unknown harness "${unknown[0]}". Valid names: ${valid()}.`,
      );
    }
    return { harnesses: HARNESSES.filter((h) => names.includes(h.name)), source: "config" };
  }
  const detected = HARNESSES.filter((h) => existsSync(join(home, h.detectDir)));
  if (detected.length === 0) {
    throw new Error(
      `no agent harness found under ${home}. Install one, or choose explicitly: git config --global ${HARNESS_CONFIG_KEY} claude-code,codex (valid names: ${valid()}).`,
    );
  }
  return { harnesses: detected, source: "detected" };
}
