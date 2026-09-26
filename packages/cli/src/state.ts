import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

export type ManagedState = {
  jsonKeys: Record<string, string[]>;
  agentFiles: string[];
  skills: Record<string, string[]>;
};
const emptyState = (): ManagedState => ({ jsonKeys: {}, agentFiles: [], skills: {} });

export function clearManagedSkills(state: ManagedState, agents: string[]): void {
  for (const [source, installed] of Object.entries(state.skills)) {
    const kept = installed.filter((agent) => !agents.includes(agent));
    if (kept.length === 0) delete state.skills[source];
    else state.skills[source] = kept;
  }
}

export function clearManagedAgentFiles(state: ManagedState, directories: string[]): void {
  state.agentFiles = state.agentFiles.filter(
    (file) =>
      !directories.some((directory) => {
        const child = relative(directory, file);
        return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
      }),
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function toStringArrayRecord(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string[]] =>
      isStringArray(entry[1]),
    ),
  );
}

export function loadState(managedFile: string): ManagedState {
  if (!existsSync(managedFile)) return emptyState();
  const raw: unknown = JSON.parse(readFileSync(managedFile, "utf8"));
  if (typeof raw !== "object" || raw === null) return emptyState();
  const record: Record<string, unknown> = raw as Record<string, unknown>;
  const jsonKeys = toStringArrayRecord(record.jsonKeys);
  const agentFiles = isStringArray(record.agentFiles) ? record.agentFiles : [];
  const skills = toStringArrayRecord(record.skills);
  return { jsonKeys, agentFiles, skills };
}

export function saveState(managedFile: string, state: ManagedState): void {
  mkdirSync(dirname(managedFile), { recursive: true });
  writeFileSync(managedFile, `${JSON.stringify(state, null, 2)}\n`);
}
