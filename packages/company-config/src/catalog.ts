import { parseAllDocuments } from "yaml";

export type Catalog = {
  domains: { name: string; owner: string }[];
  systems: { name: string; owner: string; domain: string }[];
  groups: { name: string; parent?: string; members: string[] }[];
  users: { name: string; memberOf: string[]; orgOwner: boolean }[];
};

type Entity = {
  kind: string;
  metadata: { name?: string; annotations?: Record<string, string> };
  spec?: Record<string, unknown>;
};

const fail = (file: string, message: string): never => {
  throw new Error(`${file}: ${message}`);
};
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function loadCatalog(text: string, fileName: string): Catalog {
  const docs = parseAllDocuments(text)
    .map((document) => document.toJS() as Entity | null)
    .filter((document): document is Entity => document !== null);
  const byKind = (kind: string) => docs.filter((document) => document.kind === kind);
  const name = (entity: Entity): string =>
    entity.metadata?.name ?? fail(fileName, `a ${entity.kind} entity has no metadata.name`);

  const catalog: Catalog = {
    domains: byKind("Domain").map((entity) => ({ name: name(entity), owner: str(entity.spec?.owner) })),
    systems: byKind("System").map((entity) => ({
      name: name(entity),
      owner: str(entity.spec?.owner),
      domain: str(entity.spec?.domain),
    })),
    groups: byKind("Group").map((entity) => ({
      name: name(entity),
      parent: entity.spec?.parent === undefined ? undefined : str(entity.spec.parent),
      members: strings(entity.spec?.members),
    })),
    users: byKind("User").map((entity) => ({
      name: name(entity),
      memberOf: strings(entity.spec?.memberOf),
      orgOwner: entity.metadata.annotations?.["wagglebot.dev/org-owner"] === "true",
    })),
  };

  for (const [kind, names] of Object.entries({
    Domain: catalog.domains.map((domain) => domain.name),
    System: catalog.systems.map((system) => system.name),
    Group: catalog.groups.map((group) => group.name),
    User: catalog.users.map((user) => user.name),
  })) {
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate !== undefined) fail(fileName, `duplicate ${kind} name "${duplicate}"`);
  }

  const groupNames = new Set(catalog.groups.map((group) => group.name));
  const userNames = new Set(catalog.users.map((user) => user.name));
  const domainNames = new Set(catalog.domains.map((domain) => domain.name));
  for (const domain of catalog.domains) {
    if (!groupNames.has(domain.owner))
      fail(fileName, `Domain "${domain.name}" names unknown owner Group "${domain.owner}"`);
  }
  for (const system of catalog.systems) {
    if (!groupNames.has(system.owner))
      fail(fileName, `System "${system.name}" names unknown owner Group "${system.owner}"`);
    if (!domainNames.has(system.domain))
      fail(fileName, `System "${system.name}" names unknown Domain "${system.domain}"`);
  }
  for (const group of catalog.groups) {
    if (group.parent !== undefined && !groupNames.has(group.parent)) {
      fail(fileName, `Group "${group.name}" names unknown parent "${group.parent}"`);
    }
    for (const member of group.members) {
      if (!userNames.has(member)) fail(fileName, `Group "${group.name}" names unknown member "${member}"`);
    }
  }
  for (const user of catalog.users) {
    for (const group of user.memberOf) {
      if (!groupNames.has(group)) fail(fileName, `User "${user.name}" names unknown Group "${group}"`);
    }
  }
  return catalog;
}

export const findUser = (catalog: Catalog, username: string) => catalog.users.find((user) => user.name === username);

const distance = (left: string, right: string): number => {
  const rows: number[][] = [];
  for (let i = 0; i <= left.length; i += 1) {
    const row: number[] = [];
    for (let j = 0; j <= right.length; j += 1) row.push(i === 0 ? j : j === 0 ? i : 0);
    rows.push(row);
  }
  for (let i = 1; i <= left.length; i += 1) {
    const row = rows[i];
    const previous = rows[i - 1];
    if (row === undefined || previous === undefined) continue;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      row[j] = Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
  }
  return rows[left.length]?.[right.length] ?? 0;
};

export const nearMatches = (catalog: Catalog, username: string): string[] =>
  [...catalog.users.map((user) => user.name).filter((name) => distance(name, username) <= 2)].sort();

export const teamsOf = (catalog: Catalog, username: string): string[] => {
  const viaGroups = catalog.groups.filter((group) => group.members.includes(username)).map((group) => group.name);
  const viaUser = findUser(catalog, username)?.memberOf ?? [];
  return [...new Set([...viaUser, ...viaGroups])].sort();
};
