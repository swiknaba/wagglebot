import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CompanyRepo = {
  root: string;
  pin: string;
  catalogText: string;
  catalogPath: string;
  registryBaseText?: string;
  registryTeamText: (team: string) => string | undefined;
  skillsListText?: string;
  agentListTexts: (teams: string[]) => { path: string; text: string }[];
  instructionsDir: string;
  agentsDir: string;
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
        `no company repository found above ${cwd}. Run this command inside the repository scaffolded by "bunx wagglebot@<version> init" — its package.json pins the "wagglebot" dependency.`,
      );
    }
    dir = parent;
  }
}

// Each team maintains its own file in catalogs/. All files merge into one catalog.
// A small team can keep a single catalog.yaml at the root instead. When both
// exist, catalogs/ wins.
const readCatalog = (root: string): { text: string; path: string } => {
  const dir = join(root, "catalogs");
  if (existsSync(dir)) {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .sort();
    if (files.length === 0) throw new Error(`${dir} holds no .yaml file — add one catalog file per team`);
    const text = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n---\n");
    return { text, path: join(root, "catalogs") };
  }
  const single = readOptional(join(root, "catalog.yaml"));
  if (single === undefined) {
    throw new Error(
      `${root} has no catalog — add one .yaml file per team in catalogs/, or a single catalog.yaml at the root`,
    );
  }
  return { text: single, path: join(root, "catalog.yaml") };
};

export function loadCompanyRepo(root: string): CompanyRepo {
  const pin = pinOf(root);
  if (pin === undefined) throw new Error(`${root}/package.json does not pin the "wagglebot" dependency`);
  const catalog = readCatalog(root);
  return {
    root,
    pin,
    catalogText: catalog.text,
    catalogPath: catalog.path,
    registryBaseText: readOptional(join(root, "registry.base.yaml")),
    registryTeamText: (team) => readOptional(join(root, `registry.team.${team}.yaml`)),
    skillsListText: readOptional(join(root, "skills.list")),
    agentListTexts: (teams) =>
      [
        { path: "agents.base.list", text: readOptional(join(root, "agents.base.list")) },
        ...teams.map((t) => ({
          path: `agents.team.${t}.list`,
          text: readOptional(join(root, `agents.team.${t}.list`)),
        })),
      ].flatMap((x) => (x.text === undefined ? [] : [{ path: x.path, text: x.text }])),
    instructionsDir: join(root, "instructions"),
    agentsDir: join(root, "agents"),
  };
}
