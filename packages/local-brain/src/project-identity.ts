import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectIdentity } from "@wagglebot/contracts";
import { parse } from "yaml";
import { executeGit, type GitExecutor, LocalBrainError, resolveProjectPath } from "./path-policy";

export type { GitExecutor } from "./path-policy";

export type CompanyCatalog = {
  systems: Array<{ name: string; owner: string; domain: string }>;
};

type ComponentDeclaration = {
  component: string;
  system: string;
  owner: string;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const readDeclaration = (path: string): ComponentDeclaration => {
  let document: unknown;
  try {
    document = parse(readFileSync(path, "utf8"));
  } catch {
    throw new LocalBrainError("project_not_found", "component declaration is invalid");
  }

  if (typeof document !== "object" || document === null) {
    throw new LocalBrainError("project_not_found", "component declaration is invalid");
  }
  const value = document as {
    kind?: unknown;
    metadata?: { name?: unknown };
    spec?: { owner?: unknown; system?: unknown };
  };
  const component = asString(value.metadata?.name);
  const system = asString(value.spec?.system);
  const owner = asString(value.spec?.owner);
  if (value.kind !== "Component" || component === undefined || system === undefined || owner === undefined) {
    throw new LocalBrainError("project_not_found", "component declaration is invalid");
  }
  return { component, system, owner };
};

const findDeclaration = (projectPath: string, root: string): ComponentDeclaration | undefined => {
  let current = projectPath;
  for (;;) {
    const wagglebotDeclaration = join(current, ".wagglebot", "catalog.yaml");
    const backstageDeclaration = join(current, "catalog-info.yaml");
    if (existsSync(wagglebotDeclaration)) return readDeclaration(wagglebotDeclaration);
    if (existsSync(backstageDeclaration)) return readDeclaration(backstageDeclaration);
    if (current === root) return undefined;
    current = dirname(current);
  }
};

const gitValue = async (git: GitExecutor, args: string[], cwd: string): Promise<string | undefined> => {
  try {
    const value = (await git(args, cwd)).trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
};

export const identifyProject = async (
  projectPath: string,
  companyCatalog?: CompanyCatalog,
  git: GitExecutor = executeGit,
): Promise<ProjectIdentity> => {
  const project = await resolveProjectPath(projectPath, git);
  const [head, branchValue, porcelain] = await Promise.all([
    gitValue(git, ["rev-parse", "HEAD"], project.root),
    gitValue(git, ["rev-parse", "--abbrev-ref", "HEAD"], project.root),
    gitValue(git, ["status", "--porcelain"], project.root),
  ]);
  const declaration = findDeclaration(project.projectPath, project.root);
  const branch = branchValue === "HEAD" ? undefined : branchValue;
  const base: ProjectIdentity = {
    ...(head === undefined ? {} : { head }),
    ...(branch === undefined ? {} : { branch }),
    workingTree: porcelain === undefined || porcelain === "" ? "clean" : "dirty",
    catalogState: "missing",
  };

  if (declaration === undefined) {
    return {
      ...base,
      catalogWarning: "add .wagglebot/catalog.yaml or catalog-info.yaml to enable shared identity",
    };
  }
  if (companyCatalog === undefined) {
    return {
      ...base,
      component: declaration.component,
      system: declaration.system,
      owner: declaration.owner,
      catalogWarning: "company catalog is required to validate shared identity",
    };
  }

  const system = companyCatalog.systems.find((candidate) => candidate.name === declaration.system);
  if (system === undefined)
    throw new LocalBrainError("project_not_found", "component declaration names an unknown system");
  if (system.owner !== declaration.owner) {
    throw new LocalBrainError("project_not_found", "component declaration owner conflicts with its system owner");
  }

  return {
    ...base,
    component: declaration.component,
    system: declaration.system,
    domain: system.domain,
    owner: declaration.owner,
    catalogState: "resolved",
  };
};
