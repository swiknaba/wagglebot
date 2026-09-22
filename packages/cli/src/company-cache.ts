import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import type { CompanyRepo } from "@wagglebot/company-config";
import { loadCompanyRepo } from "@wagglebot/company-config";
import { rejectRepositoryCredentials } from "./company-url";
import type { Exec } from "./exec";
import type { WagglePaths } from "./paths";

const EXACT_PIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type CompanyCacheResult = {
  root: string;
  refreshFailed: boolean;
  warning?: string;
  settleCredentials?: () => boolean;
};

export function isCompanyCacheRoot(root: string, paths: WagglePaths): boolean {
  if (!existsSync(paths.companyDir)) return false;
  const rel = relative(realpathSync(paths.companyDir), realpathSync(root));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
}

// Keep both loading paths until shell configuration succeeds. No credential values are read or copied.
export function migrateCachedCredentials(paths: WagglePaths): (() => void) | undefined {
  if (!pathExists(paths.activeCompanyDir)) return;
  const legacy = join(realpathSync(paths.activeCompanyDir), ".env.credentials");
  if (!pathExists(legacy)) return;
  if (!lstatSync(legacy).isFile()) throw new Error("The legacy credential file must be a regular file.");
  if (!pathExists(paths.credentialsFile)) {
    linkSync(legacy, paths.credentialsFile);
    chmodSync(paths.credentialsFile, 0o600);
  }
  const sameFile = (): boolean => {
    if (!pathExists(legacy) || !pathExists(paths.credentialsFile)) return false;
    const old = lstatSync(legacy);
    const stable = lstatSync(paths.credentialsFile);
    return old.isFile() && stable.isFile() && old.dev === stable.dev && old.ino === stable.ino;
  };
  return () => {
    if (sameFile()) unlinkSync(legacy);
  };
}

// The receipt identifies the completed shell stage, independent of other provisioning failures.
export function recordCachedShellReady(paths: WagglePaths, root: string): void {
  mkdirSync(paths.stateDir, { recursive: true });
  const temporary = join(paths.stateDir, `.company-shell-ready-${randomUUID()}`);
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, realpathSync(root));
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, join(paths.stateDir, "company-shell-ready"));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) rmSync(temporary, { force: true });
  }
}

const cachedShellReady = (paths: WagglePaths, revision: string): boolean => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      join(paths.stateDir, "company-shell-ready"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const receipt = fstatSync(descriptor);
    if (!receipt.isFile() || (receipt.mode & 0o777) !== 0o600) return false;
    return readFileSync(descriptor, "utf8") === realpathSync(revision);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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
  rejectRepositoryCredentials(input.url);
  const { paths } = input;
  const companyDirExisted = pathExists(paths.companyDir);
  const activeExisted = pathExists(paths.activeCompanyDir);
  const previousRoot = activeExisted ? realpathSync(paths.activeCompanyDir) : undefined;
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
    const commitCredentials = migrateCachedCredentials(paths);
    mkdirSync(revisionsDir, { recursive: true });
    const candidateRevision = join(revisionsDir, randomUUID());
    renameSync(candidate, candidateRevision);
    candidate = undefined;
    revision = candidateRevision;

    symlinkSync(join("revisions", basename(revision)), nextPath, "dir");
    nextCreated = true;
    renameSync(nextPath, paths.activeCompanyDir);
    nextCreated = false;
    const activatedRevision = revision;
    return {
      root: paths.activeCompanyDir,
      refreshFailed: false,
      settleCredentials:
        commitCredentials === undefined
          ? undefined
          : () => {
              if (cachedShellReady(paths, activatedRevision)) {
                commitCredentials();
                return true;
              }
              if (realpathSync(paths.activeCompanyDir) !== realpathSync(activatedRevision))
                throw new Error("Company cache changed before credential migration completed.");
              if (previousRoot === undefined) throw new Error("The legacy company cache is unavailable.");
              const rollbackLink = join(paths.companyDir, `rollback-${randomUUID()}`);
              try {
                symlinkSync(previousRoot, rollbackLink, "dir");
                renameSync(rollbackLink, paths.activeCompanyDir);
              } finally {
                removeOwnedPath(rollbackLink);
              }
              return false;
            },
    };
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
