import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ManagedState = { jsonKeys: Record<string, string[]>; agentFiles: string[] };
const EMPTY: ManagedState = { jsonKeys: {}, agentFiles: [] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function toJsonKeys(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string[]] =>
      isStringArray(entry[1]),
    ),
  );
}

export function loadState(managedFile: string): ManagedState {
  if (!existsSync(managedFile)) return { ...EMPTY };
  const raw: unknown = JSON.parse(readFileSync(managedFile, "utf8"));
  if (typeof raw !== "object" || raw === null) return { ...EMPTY };
  const record: Record<string, unknown> = raw as Record<string, unknown>;
  const jsonKeys = toJsonKeys(record.jsonKeys);
  const agentFiles = isStringArray(record.agentFiles) ? record.agentFiles : [];
  return { jsonKeys, agentFiles };
}

export function saveState(managedFile: string, state: ManagedState): void {
  mkdirSync(dirname(managedFile), { recursive: true });
  writeFileSync(managedFile, `${JSON.stringify(state, null, 2)}\n`);
}
