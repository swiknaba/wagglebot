import { createHash } from "node:crypto";
import {
  type AuthPrincipal,
  type ProxyConfig,
  type RegistrySnapshot,
  RegistrySnapshotSchema,
} from "@wagglebot/contracts";
import type { ValidatedSourceSnapshot } from "./catalog";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function composeRegistry(
  principal: Pick<AuthPrincipal, "username">,
  source: ValidatedSourceSnapshot,
): RegistrySnapshot {
  if (!source.catalog.users.has(principal.username)) throw new Error("principal is not registered");
  const groups = [...source.catalog.groupsFor(principal.username)].sort();
  const merged = new Map<string, ProxyConfig>();
  for (const entry of [...source.company, ...groups.flatMap((group) => source.teams.get(group) ?? [])])
    merged.set(entry.namespace, entry);
  const proxies = [...merged.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
  const candidate = {
    schemaVersion: 1,
    revision: `reg_${"0".repeat(64)}`,
    sourceRevision: source.sourceRevision,
    generatedAt: source.generatedAt,
    principal: { username: principal.username },
    proxies,
    toolCatalog: source.toolCatalog,
  };
  const digest = `wagglebot:registry:v1\0${source.sourceRevision}\0${principal.username}\0${canonical({ proxies, toolCatalog: source.toolCatalog })}`;
  return RegistrySnapshotSchema.parse({
    ...candidate,
    revision: `reg_${createHash("sha256").update(digest).digest("hex")}`,
  });
}
