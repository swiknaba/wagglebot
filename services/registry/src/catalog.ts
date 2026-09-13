import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertTeamDirsKnown, type CompanyRepo, loadCompanyRepo } from "@wagglebot/company-config";
import {
  FullGitShaSchema,
  type ProxyConfig,
  ProxyConfigSchema,
  type ToolCatalog,
  ToolCatalogSchema,
} from "@wagglebot/contracts";
import { parse, parseAllDocuments } from "yaml";

type Entity = { kind?: unknown; metadata?: { name?: unknown }; spec?: { members?: unknown; memberOf?: unknown } };
export type CatalogSnapshot = {
  users: Map<string, string[]>;
  groups: Set<string>;
  groupsFor: (username: string) => string[];
};
export type ValidatedSourceSnapshot = {
  sourceRevision: string;
  generatedAt: string;
  catalog: CatalogSnapshot;
  company: ProxyConfig[];
  teams: Map<string, ProxyConfig[]>;
  toolCatalog: ToolCatalog;
};

function entities(text: string, file: string): Entity[] {
  return parseAllDocuments(text).map((doc, index) => {
    if (doc.errors.length > 0) throw new Error(`${file} document ${index + 1}: invalid YAML`);
    const value = doc.toJSON() as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error(`${file}: entity must be a mapping`);
    return value as Entity;
  });
}

function parseRegistry(text: string | undefined, file: string): ProxyConfig[] {
  if (text === undefined) return [];
  const value = parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${file}: registry must be a mapping`);
  for (const key of Object.keys(value)) if (key !== "proxies") throw new Error(`${file}: unknown key "${key}"`);
  const proxies = (value as { proxies?: unknown }).proxies;
  if (proxies === undefined) return [];
  if (!Array.isArray(proxies)) throw new Error(`${file}: proxies must be a list`);
  const seen = new Set<string>();
  return proxies.map((raw, index) => {
    const result = ProxyConfigSchema.safeParse(raw);
    if (!result.success) throw new Error(`${file} proxy ${index + 1}: invalid registry entry`);
    if (seen.has(result.data.namespace)) throw new Error(`${file}: duplicate namespace ${result.data.namespace}`);
    seen.add(result.data.namespace);
    return result.data;
  });
}

function parseCatalog(repo: CompanyRepo): CatalogSnapshot {
  const users = new Map<string, string[]>();
  const groups = new Set<string>();
  const members = new Map<string, string[]>();
  for (const layer of [repo.company, ...repo.teams]) {
    if (layer.catalogText === undefined) continue;
    for (const entity of entities(layer.catalogText, join(layer.dir, "catalog.yaml"))) {
      const name = entity.metadata?.name;
      if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(name))
        throw new Error("catalog entity name is invalid");
      if (entity.kind === "Group") {
        if (groups.has(name)) throw new Error(`duplicate Group ${name}`);
        groups.add(name);
        const raw = entity.spec?.members;
        members.set(name, Array.isArray(raw) && raw.every((item) => typeof item === "string") ? raw : []);
      } else if (entity.kind === "User") {
        if (users.has(name)) throw new Error(`duplicate User ${name}`);
        const raw = entity.spec?.memberOf;
        users.set(name, Array.isArray(raw) && raw.every((item) => typeof item === "string") ? raw : []);
      }
    }
  }
  for (const [username, groupNames] of users) {
    for (const group of groupNames)
      if (!groups.has(group)) throw new Error(`User ${username} references unknown Group ${group}`);
  }
  for (const [group, names] of members)
    for (const username of names)
      if (!users.has(username)) throw new Error(`Group ${group} references unknown User ${username}`);
  return { users, groups, groupsFor: (username) => users.get(username) ?? [] };
}

export function loadCatalog(root: string, sourceRevision: string): ValidatedSourceSnapshot {
  if (!FullGitShaSchema.safeParse(sourceRevision).success) throw new Error("source revision must be a full Git SHA");
  const repo = loadCompanyRepo(root);
  for (const old of ["registry.base.yaml", "registry.team.yaml"])
    if (existsSync(join(root, old))) throw new Error(`removed registry layout: ${old}`);
  const toolPath = join(root, "tool_catalog.yaml");
  if (!existsSync(toolPath)) throw new Error("tool_catalog.yaml is required");
  const toolResult = ToolCatalogSchema.safeParse(parse(readFileSync(toolPath, "utf8")));
  if (!toolResult.success) throw new Error("tool_catalog.yaml: invalid tool catalog");
  const catalog = parseCatalog(repo);
  assertTeamDirsKnown(repo, [...catalog.groups]);
  const teams = new Map<string, ProxyConfig[]>();
  for (const team of repo.teams)
    teams.set(team.name, parseRegistry(team.registryText, join(team.dir, "registry.yaml")));
  return {
    sourceRevision,
    generatedAt: new Date().toISOString(),
    catalog,
    company: parseRegistry(repo.company.registryText, join(repo.company.dir, "registry.yaml")),
    teams,
    toolCatalog: toolResult.data,
  };
}
