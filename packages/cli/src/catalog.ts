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
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function loadCatalog(text: string, fileName: string): Catalog {
  const docs = parseAllDocuments(text)
    .map((d) => d.toJS() as Entity | null)
    .filter((d): d is Entity => d !== null);
  const byKind = (kind: string) => docs.filter((d) => d.kind === kind);
  const name = (e: Entity): string => e.metadata?.name ?? fail(fileName, `a ${e.kind} entity has no metadata.name`);

  const catalog: Catalog = {
    domains: byKind("Domain").map((e) => ({ name: name(e), owner: str(e.spec?.owner) })),
    systems: byKind("System").map((e) => ({ name: name(e), owner: str(e.spec?.owner), domain: str(e.spec?.domain) })),
    groups: byKind("Group").map((e) => ({
      name: name(e),
      parent: e.spec?.parent === undefined ? undefined : str(e.spec.parent),
      members: strings(e.spec?.members),
    })),
    users: byKind("User").map((e) => ({
      name: name(e),
      memberOf: strings(e.spec?.memberOf),
      orgOwner: e.metadata.annotations?.["wagglebot.dev/org-owner"] === "true",
    })),
  };

  for (const [kind, list] of Object.entries({
    Domain: catalog.domains.map((d) => d.name),
    System: catalog.systems.map((s) => s.name),
    Group: catalog.groups.map((g) => g.name),
    User: catalog.users.map((u) => u.name),
  })) {
    const dupes = list.filter((n, i) => list.indexOf(n) !== i);
    if (dupes.length > 0) fail(fileName, `duplicate ${kind} name "${dupes[0]}"`);
  }

  const groupNames = new Set(catalog.groups.map((g) => g.name));
  const userNames = new Set(catalog.users.map((u) => u.name));
  const domainNames = new Set(catalog.domains.map((d) => d.name));
  for (const d of catalog.domains)
    if (!groupNames.has(d.owner)) fail(fileName, `Domain "${d.name}" names unknown owner Group "${d.owner}"`);
  for (const s of catalog.systems) {
    if (!groupNames.has(s.owner)) fail(fileName, `System "${s.name}" names unknown owner Group "${s.owner}"`);
    if (!domainNames.has(s.domain)) fail(fileName, `System "${s.name}" names unknown Domain "${s.domain}"`);
  }
  for (const g of catalog.groups) {
    if (g.parent !== undefined && !groupNames.has(g.parent))
      fail(fileName, `Group "${g.name}" names unknown parent "${g.parent}"`);
    for (const m of g.members) if (!userNames.has(m)) fail(fileName, `Group "${g.name}" names unknown member "${m}"`);
  }
  for (const u of catalog.users)
    for (const g of u.memberOf) if (!groupNames.has(g)) fail(fileName, `User "${u.name}" names unknown Group "${g}"`);
  return catalog;
}

export const findUser = (catalog: Catalog, username: string) => catalog.users.find((u) => u.name === username);

const distance = (a: string, b: string): number => {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) {
    const row: number[] = [];
    for (let j = 0; j <= b.length; j += 1) row.push(i === 0 ? j : j === 0 ? i : 0);
    rows.push(row);
  }
  for (let i = 1; i <= a.length; i += 1) {
    const row = rows[i];
    const prevRow = rows[i - 1];
    if (row === undefined || prevRow === undefined) continue;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const above = prevRow[j] ?? 0;
      const left = row[j - 1] ?? 0;
      const diag = prevRow[j - 1] ?? 0;
      row[j] = Math.min(above + 1, left + 1, diag + cost);
    }
  }
  const lastRow = rows[a.length];
  return lastRow?.[b.length] ?? 0;
};

export const nearMatches = (catalog: Catalog, username: string): string[] =>
  [...catalog.users.map((u) => u.name).filter((n) => distance(n, username) <= 2)].sort();

export const teamsOf = (catalog: Catalog, username: string): string[] => {
  const viaGroups = catalog.groups.filter((g) => g.members.includes(username)).map((g) => g.name);
  const viaUser = findUser(catalog, username)?.memberOf ?? [];
  return [...new Set([...viaUser, ...viaGroups])].sort();
};
