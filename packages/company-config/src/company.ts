import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  catalogText: string;
  catalogPath: string;
  layersFor: (teamNames: string[]) => Layer[];
};
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
const pinOf = (root: string): string | undefined => readPackageJson(root)?.dependencies?.wagglebot;
export function findCompanyRoot(cwd: string): string {
  let dir = cwd;
  while (true) {
    if (pinOf(dir) !== undefined) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `no company repository found above ${cwd}. Run this command inside the repository scaffolded by "wagglebot init" — its package.json pins the "wagglebot" dependency.`,
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
  if (catalogs.length === 0) {
    throw new Error(`${root} has no catalog.yaml — add teams/<team>/catalog.yaml for each team`);
  }
  return {
    root,
    pin,
    organization,
    company,
    teams,
    catalogText: catalogs.map((layer) => layer.catalogText ?? "").join("\n---\n"),
    catalogPath: catalogs.map((layer) => join(layer.dir, "catalog.yaml")).join(", "),
    layersFor: (teamNames) => [company, ...teams.filter((team) => teamNames.includes(team.name))],
  };
}
export function assertTeamDirsKnown(company: CompanyRepo, groupNames: string[]): void {
  for (const team of company.teams) {
    if (!groupNames.includes(team.name)) throw new Error(`teams/${team.name} matches no Group in the catalog`);
  }
}
