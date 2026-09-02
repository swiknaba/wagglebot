import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CompanyRepo = {
  root: string;
  pin: string;
  catalogText: string;
  registryBaseText?: string;
  registryTeamText: (team: string) => string | undefined;
  skillsListText?: string;
  agentListTexts: (teams: string[]) => { path: string; text: string }[];
  overlaysDir: string;
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

export function loadCompanyRepo(root: string): CompanyRepo {
  const pin = pinOf(root);
  if (pin === undefined) throw new Error(`${root}/package.json does not pin the "wagglebot" dependency`);
  const catalogText = readOptional(join(root, "catalog.yaml"));
  if (catalogText === undefined) throw new Error(`${root}/catalog.yaml is missing — the catalog is required (D20)`);
  return {
    root,
    pin,
    catalogText,
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
    overlaysDir: join(root, "overlays"),
  };
}
