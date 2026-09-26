import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";

export type Layer = {
  name: string;
  dir: string;
  catalogText?: string;
  registryText?: string;
  skillsListText?: string;
  agentsListText?: string;
  agentsDir: string;
  instructionsDir: string;
};
export type CompanyRepo = {
  root: string;
  pin: string;
  organization: string[];
  company: Layer;
  teams: Layer[];
  catalog?: CompanyCatalog;
  layersFor: (teamNames: string[]) => Layer[];
};
export type CompanyCatalog = { text: string; path: string };
const readOptional = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
type CompanyPackage = { dependencies?: Record<string, string>; wagglebot?: { organization?: unknown } };
const readPackageJson = (root: string): CompanyPackage | undefined => {
  const path = join(root, "package.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
};
const readPackage = (root: string): { pin?: string; organization: string[] } => {
  const pkg = readPackageJson(root);
  if (pkg === undefined) return { organization: [] };
  const raw = pkg.wagglebot?.organization;
  if (raw !== undefined && !(Array.isArray(raw) && raw.every((p) => typeof p === "string"))) {
    throw new Error(`${join(root, "package.json")}: "wagglebot.organization" must be a list of "host/path" prefixes`);
  }
  return { pin: pkg.dependencies?.wagglebot, organization: raw ?? [] };
};
const markerPath = (root: string): string => join(root, "wagglebot.yaml");
export function readCompanyMarker(root: string): { version: 1; kind: "company" } | undefined {
  const path = markerPath(root);
  if (!existsSync(path)) return undefined;
  let marker: unknown;
  try {
    const document = parseDocument(readFileSync(path, "utf8"));
    if (document.errors.length > 0) throw document.errors[0];
    marker = document.toJS();
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`${path} is not a valid company marker${detail}`);
  }
  if (
    typeof marker !== "object" ||
    marker === null ||
    Array.isArray(marker) ||
    Object.keys(marker).length !== 2 ||
    (marker as Record<string, unknown>).version !== 1 ||
    (marker as Record<string, unknown>).kind !== "company"
  ) {
    throw new Error(`${path} must contain only version: 1 and kind: company`);
  }
  return { version: 1, kind: "company" };
}
export function isCompanyRoot(root: string): boolean {
  return readCompanyMarker(root) !== undefined;
}
export function findCompanyRoot(cwd: string): string {
  let dir = cwd;
  while (true) {
    if (isCompanyRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `no company repository found above ${cwd}. Run this command inside a repository that has a valid wagglebot.yaml marker.`,
      );
    }
    dir = parent;
  }
}
const readLayer = (name: string, dir: string): Layer => ({
  name,
  dir,
  catalogText: readOptional(join(dir, "catalog.yaml")),
  registryText: readOptional(join(dir, "registry.yaml")),
  skillsListText: readOptional(join(dir, "skills.list")),
  agentsListText: readOptional(join(dir, "agents.list")),
  agentsDir: join(dir, "agents"),
  instructionsDir: join(dir, "instructions"),
});
export function loadCompanyRepo(root: string): CompanyRepo {
  if (readCompanyMarker(root) === undefined)
    throw new Error(`${markerPath(root)} is required for a company repository`);
  const { pin, organization } = readPackage(root);
  if (pin === undefined) throw new Error(`${root}/package.json does not pin the "wagglebot" dependency`);
  const company = readLayer("company", join(root, "company"));
  const teamsDir = join(root, "teams");
  const teams = existsSync(teamsDir)
    ? readdirSync(teamsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .map((name) => readLayer(name, join(teamsDir, name)))
    : [];
  const catalogs = [company, ...teams].filter((layer) => layer.catalogText !== undefined);
  return {
    root,
    pin,
    organization,
    company,
    teams,
    catalog:
      catalogs.length === 0
        ? undefined
        : {
            text: catalogs.map((layer) => layer.catalogText ?? "").join("\n---\n"),
            path: catalogs.map((layer) => join(layer.dir, "catalog.yaml")).join(", "),
          },
    layersFor: (teamNames) => [company, ...teams.filter((team) => teamNames.includes(team.name))],
  };
}
export function assertTeamDirsKnown(company: CompanyRepo, groupNames: string[]): void {
  for (const team of company.teams) {
    if (!groupNames.includes(team.name)) throw new Error(`teams/${team.name} matches no Group in the catalog`);
  }
}
