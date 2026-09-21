import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { CompanyRepo } from "@wagglebot/company-config";
import { loadCompanyRepo } from "@wagglebot/company-config";
import type { Exec } from "./exec";
import type { WagglePaths } from "./paths";

const EXACT_PIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type CompanyCacheResult = {
  root: string;
  refreshFailed: boolean;
  warning?: string;
};

export function validateCompanyBase(root: string): { pin: string; company: CompanyRepo } {
  const company = loadCompanyRepo(root);
  if (!EXACT_PIN.test(company.pin)) {
    throw new Error(`${join(root, "package.json")} must pin "wagglebot" to an exact version`);
  }
  if (!existsSync(company.company.dir) || !statSync(company.company.dir).isDirectory()) {
    throw new Error(`${company.company.dir} is required for a company repository`);
  }
  return { pin: company.pin, company };
}

const pathExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const detailFor = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const failedRefresh = (error: unknown): Error => new Error(`company refresh failed: ${detailFor(error)}`);

const removeOwnedPath = (path: string | undefined): void => {
  if (path !== undefined) rmSync(path, { recursive: true, force: true });
};

const removeNewCacheDirectories = (
  paths: WagglePaths,
  companyDirExisted: boolean,
  revisionsDirCreated: boolean,
): void => {
  if (companyDirExisted) return;
  if (revisionsDirCreated) {
    try {
      rmdirSync(join(paths.companyDir, "revisions"));
    } catch {}
  }
  try {
    rmdirSync(paths.companyDir);
  } catch {}
};

export async function refreshCompanyCache(input: {
  url: string;
  paths: WagglePaths;
  exec: Exec;
}): Promise<CompanyCacheResult> {
  const { paths } = input;
  const companyDirExisted = pathExists(paths.companyDir);
  const activeExisted = pathExists(paths.activeCompanyDir);
  const revisionsDir = join(paths.companyDir, "revisions");
  const revisionsDirCreated = !pathExists(revisionsDir);
  const nextPath = join(paths.companyDir, "active.next");
  let candidate: string | undefined;
  let revision: string | undefined;
  let nextCreated = false;

  try {
    mkdirSync(paths.companyDir, { recursive: true });
    candidate = join(paths.companyDir, `tmp-${randomUUID()}`);
    mkdirSync(candidate);
    const clone = await input.exec("git", ["clone", "--depth", "1", input.url, candidate]);
    if (clone.code !== 0) throw new Error(clone.stderr.trim() || "git clone failed");

    validateCompanyBase(candidate);
    mkdirSync(revisionsDir, { recursive: true });
    const candidateRevision = join(revisionsDir, randomUUID());
    renameSync(candidate, candidateRevision);
    candidate = undefined;
    revision = candidateRevision;

    symlinkSync(join("revisions", basename(revision)), nextPath, "dir");
    nextCreated = true;
    renameSync(nextPath, paths.activeCompanyDir);
    nextCreated = false;
    return { root: paths.activeCompanyDir, refreshFailed: false };
  } catch (error) {
    removeOwnedPath(candidate);
    removeOwnedPath(revision);
    if (nextCreated) removeOwnedPath(nextPath);
    removeNewCacheDirectories(paths, companyDirExisted, revisionsDirCreated);
    const failure = failedRefresh(error);
    if (activeExisted) return { root: paths.activeCompanyDir, refreshFailed: true, warning: failure.message };
    throw failure;
  }
}
