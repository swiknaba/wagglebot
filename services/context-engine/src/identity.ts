import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { loadCatalog, loadCompanyRepo } from "@wagglebot/company-config";
import type { ProjectIdentity } from "@wagglebot/contracts";
import { type CompanyCatalog, identifyProject, LocalBrainError } from "@wagglebot/local-brain";

export type ProjectIdentityOptions = {
  companyRoot?: string | null;
  homeDirectory?: string;
};

const invalidCompanyCatalog = (): LocalBrainError =>
  new LocalBrainError("project_not_found", "Company catalog configuration is invalid.");

const normalizeSubdirectory = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("invalid company subdirectory");
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === ".") return undefined;
  if (trimmed.includes("\\") || isAbsolute(trimmed)) throw new Error("invalid company subdirectory");
  const normalized = normalize(trimmed);
  if (normalized === ".") return undefined;
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) throw new Error("invalid company subdirectory");
  return normalized;
};

const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const cachedCompanyRoot = (homeDirectory: string): string | undefined => {
  const active = join(homeDirectory, ".wagglebot", "company", "active");
  const configPath = join(homeDirectory, ".wagglebot", "config.json");
  try {
    if (!existsSync(active)) return undefined;
    let subdirectory: string | undefined;
    if (existsSync(configPath)) {
      const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
      subdirectory = normalizeSubdirectory((config as { companySubdirectory?: unknown }).companySubdirectory);
    }
    const canonicalActive = realpathSync(active);
    const selected = subdirectory === undefined ? canonicalActive : resolve(canonicalActive, subdirectory);
    const canonicalSelected = realpathSync(selected);
    return isWithin(canonicalActive, canonicalSelected) ? canonicalSelected : undefined;
  } catch {
    return undefined;
  }
};

export const identifyProjectWithCompanyCatalog = async (
  projectPath: string,
  options: ProjectIdentityOptions = {},
): Promise<ProjectIdentity> => {
  const configuredRoot =
    options.companyRoot === null ? undefined : (options.companyRoot ?? process.env.WAGGLEBOT_COMPANY_ROOT);
  const explicitlyConfigured = options.companyRoot !== null && configuredRoot !== undefined;
  const root = explicitlyConfigured ? configuredRoot?.trim() : cachedCompanyRoot(options.homeDirectory ?? homedir());

  if (explicitlyConfigured && (root === undefined || root.length === 0 || !existsSync(root)))
    throw invalidCompanyCatalog();
  if (root === undefined) return identifyProject(projectPath);

  let companyCatalog: CompanyCatalog | undefined;
  try {
    const company = loadCompanyRepo(resolve(root));
    if (company.catalog === undefined) {
      if (explicitlyConfigured) throw invalidCompanyCatalog();
    } else {
      const catalog = loadCatalog(company.catalog.text, company.catalog.path);
      companyCatalog = { systems: catalog.systems };
    }
  } catch {
    if (explicitlyConfigured) throw invalidCompanyCatalog();
    return identifyProject(projectPath);
  }

  if (companyCatalog === undefined) return identifyProject(projectPath);
  try {
    return await identifyProject(projectPath, companyCatalog);
  } catch {
    if (explicitlyConfigured) throw invalidCompanyCatalog();
    return identifyProject(projectPath);
  }
};
