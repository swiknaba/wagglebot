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
  company: Layer;
  teams: Layer[];
  catalogText: string;
  catalogPath: string;
  layersFor: (teamNames: string[]) => Layer[];
};

const readOptional = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

const pinOf = (root: string): string | undefined => {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  const pkg: { dependencies?: Record<string, string> } = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.dependencies?.wagglebot;
};

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

// company/ and every teams/<team>/ directory share one shape. A team directory is named
// after its Group, so a member of Group "payments" gets the layer teams/payments/.
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
  const pin = pinOf(root);
  if (pin === undefined) throw new Error(`${root}/package.json does not pin the "wagglebot" dependency`);
  const company = readLayer("company", join(root, "company"));
  const teamsDir = join(root, "teams");
  const teams = existsSync(teamsDir)
    ? readdirSync(teamsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .map((name) => readLayer(name, join(teamsDir, name)))
    : [];
  const catalogs = [company, ...teams].filter((l) => l.catalogText !== undefined);
  if (catalogs.length === 0) {
    throw new Error(
      `${root} has no catalog — add teams/<team>/catalog.yaml for each team (and optionally company/catalog.yaml)`,
    );
  }
  return {
    root,
    pin,
    company,
    teams,
    catalogText: catalogs.map((l) => l.catalogText ?? "").join("\n---\n"),
    catalogPath: catalogs.map((l) => join(l.dir, "catalog.yaml")).join(", "),
    layersFor: (teamNames) => [company, ...teams.filter((t) => teamNames.includes(t.name))],
  };
}

// The catalog is the single source of truth (D20, D27). A team directory with no Group
// behind it would silently apply to nobody, so it is a hard error.
export function assertTeamDirsKnown(company: CompanyRepo, groupNames: string[]): void {
  for (const team of company.teams) {
    if (!groupNames.includes(team.name)) {
      throw new Error(
        `teams/${team.name} matches no Group in the catalog — name the directory after the Group, or add the Group to ${join(team.dir, "catalog.yaml")}`,
      );
    }
  }
}
