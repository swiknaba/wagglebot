import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateCachedCredentials,
  recordCachedShellReady,
  refreshCompanyCache,
  validateCompanyBase,
} from "./company-cache";
import { realExec } from "./exec";
import { resolvePaths } from "./paths";

const runGit = (cwd: string, args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
};

for (const mode of [0o200, 0o666]) {
  test(`shell receipt replaces existing mode ${mode.toString(8)} with readable owner-only permissions`, () => {
    const home = mkdtempSync(join(tmpdir(), "wgl-receipt-"));
    try {
      const paths = resolvePaths(home);
      mkdirSync(paths.stateDir);
      const receipt = join(paths.stateDir, "company-shell-ready");
      writeFileSync(receipt, "old");
      chmodSync(receipt, mode);
      recordCachedShellReady(paths, home);
      expect(lstatSync(receipt).mode & 0o777).toBe(0o600);
      expect(readFileSync(receipt, "utf8")).toBe(realpathSync(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("shell receipt replacement does not follow an existing symlink", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-receipt-"));
  try {
    const paths = resolvePaths(home);
    mkdirSync(paths.stateDir);
    const target = join(home, "personal-file");
    writeFileSync(target, "Personal fixture remains unchanged.", { mode: 0o644 });
    const receipt = join(paths.stateDir, "company-shell-ready");
    symlinkSync(target, receipt);
    recordCachedShellReady(paths, home);
    expect(readFileSync(target, "utf8")).toBe("Personal fixture remains unchanged.");
    expect(lstatSync(target).mode & 0o777).toBe(0o644);
    expect(lstatSync(receipt).isSymbolicLink()).toBe(false);
    expect(lstatSync(receipt).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const makeRemote = () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-company-cache-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  runGit(root, ["init", "-b", "main", source]);
  runGit(source, ["config", "user.email", "cache@example.test"]);
  runGit(source, ["config", "user.name", "Cache Test"]);
  writeCandidate(source, "first");
  runGit(source, ["add", "."]);
  runGit(source, ["-c", "commit.gpgsign=false", "commit", "-m", "first"]);
  runGit(root, ["init", "--bare", remote]);
  runGit(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  runGit(source, ["remote", "add", "origin", remote]);
  runGit(source, ["push", "-u", "origin", "main"]);
  return { root, source, remote };
};

const writeCandidate = (
  root: string,
  revision: string,
  options: { marker?: boolean; company?: boolean; pin?: string; subdirectory?: string } = {},
) => {
  const companyRoot = options.subdirectory === undefined ? root : join(root, options.subdirectory);
  mkdirSync(companyRoot, { recursive: true });
  if (options.marker !== false) writeFileSync(join(companyRoot, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(
    join(companyRoot, "package.json"),
    JSON.stringify({ dependencies: { wagglebot: options.pin ?? "1.2.3" } }),
  );
  if (options.company !== false) {
    mkdirSync(join(companyRoot, "company"), { recursive: true });
    writeFileSync(join(companyRoot, "company", ".keep"), "");
  }
  writeFileSync(join(companyRoot, "revision.txt"), revision);
};

const pushCandidate = (
  source: string,
  revision: string,
  options: { marker?: boolean; company?: boolean; pin?: string; subdirectory?: string } = {},
) => {
  runGit(source, ["rm", "-rf", "."]);
  writeCandidate(source, revision, options);
  runGit(source, ["add", "-A"]);
  runGit(source, ["-c", "commit.gpgsign=false", "commit", "-m", revision]);
  runGit(source, ["push", "origin", "main"]);
};

const readRevision = (root: string) => readFileSync(join(root, "revision.txt"), "utf8");

test("credential migration preserves an existing stable file and leaves the legacy file untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-credential-migration-"));
  try {
    const paths = resolvePaths(home);
    mkdirSync(paths.activeCompanyDir, { recursive: true });
    const legacy = join(paths.activeCompanyDir, ".env.credentials");
    writeFileSync(legacy, "TOKEN=legacy-fixture\n");
    writeFileSync(paths.credentialsFile, "TOKEN=stable-fixture\n");
    migrateCachedCredentials(paths);
    expect(readFileSync(legacy, "utf8")).toBe("TOKEN=legacy-fixture\n");
    expect(readFileSync(paths.credentialsFile, "utf8")).toBe("TOKEN=stable-fixture\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the cache rejects HTTP userinfo before any direct clone", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-url-clone-"));
  const calls: string[] = [];
  try {
    await expect(
      refreshCompanyCache({
        url: "https://user:fixture-token@git.internal/company.git",
        paths: resolvePaths(home),
        exec: async (cmd) => {
          calls.push(cmd);
          return { code: 1, stdout: "", stderr: "fixture refused clone" };
        },
      }),
    ).rejects.toThrow("credential");
    expect(calls).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("first refresh clones and activates a valid candidate", async () => {
  const remote = makeRemote();
  const home = mkdtempSync(join(tmpdir(), "wgl-company-home-"));
  const paths = resolvePaths(home);

  const result = await refreshCompanyCache({ url: remote.remote, paths, exec: realExec });

  expect(result).toEqual({ root: paths.activeCompanyDir, refreshFailed: false });
  expect(readRevision(result.root)).toBe("first");
  expect(lstatSync(paths.activeCompanyDir).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(paths.activeCompanyDir, "package.json"), "utf8")).toContain('"1.2.3"');
  rmSync(remote.root, { recursive: true, force: true });
});

test("first refresh activates a validated company subdirectory", async () => {
  const remote = makeRemote();
  const home = mkdtempSync(join(tmpdir(), "wgl-company-home-"));
  const paths = resolvePaths(home);
  pushCandidate(remote.source, "reference", { subdirectory: "examples/reference-setup" });

  const result = await refreshCompanyCache({
    url: remote.remote,
    subdirectory: "examples/reference-setup",
    paths,
    exec: realExec,
  });

  expect(result).toEqual({ root: join(paths.activeCompanyDir, "examples/reference-setup"), refreshFailed: false });
  expect(readRevision(result.root)).toBe("reference");
  rmSync(remote.root, { recursive: true, force: true });
});

test("refresh rejects traversal before cloning", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-company-home-"));
  const calls: string[] = [];
  await expect(
    refreshCompanyCache({
      url: "https://github.com/platform/company.git",
      subdirectory: "../outside",
      paths: resolvePaths(home),
      exec: async (command) => {
        calls.push(command);
        return { code: 1, stdout: "", stderr: "should not run" };
      },
    }),
  ).rejects.toThrow(/stay inside/);
  expect(calls).toEqual([]);
  rmSync(home, { recursive: true, force: true });
});

test("refresh rejects a subdirectory symlink that resolves outside the repository", async () => {
  const remote = makeRemote();
  const outside = mkdtempSync(join(tmpdir(), "wgl-company-outside-"));
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "wgl-company-home-")));
  symlinkSync(outside, join(remote.source, "reference"));
  runGit(remote.source, ["add", "reference"]);
  runGit(remote.source, ["-c", "commit.gpgsign=false", "commit", "-m", "outside link"]);
  runGit(remote.source, ["push", "origin", "main"]);

  await expect(
    refreshCompanyCache({ url: remote.remote, subdirectory: "reference", paths, exec: realExec }),
  ).rejects.toThrow(/resolve inside/);
  expect(existsSync(paths.companyDir)).toBe(false);
  rmSync(remote.root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("a later valid revision replaces the active cache", async () => {
  const remote = makeRemote();
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "wgl-company-home-")));
  await refreshCompanyCache({ url: remote.remote, paths, exec: realExec });
  pushCandidate(remote.source, "second");

  const result = await refreshCompanyCache({ url: remote.remote, paths, exec: realExec });

  expect(result.refreshFailed).toBe(false);
  expect(readRevision(result.root)).toBe("second");
  rmSync(remote.root, { recursive: true, force: true });
});

test.each([
  ["without a marker", { marker: false }],
  ["without a company layer", { company: false }],
])("a candidate %s does not replace the active cache", async (_description, options) => {
  const remote = makeRemote();
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "wgl-company-home-")));
  await refreshCompanyCache({ url: remote.remote, paths, exec: realExec });
  pushCandidate(remote.source, "invalid", options);

  const result = await refreshCompanyCache({ url: remote.remote, paths, exec: realExec });

  expect(result.refreshFailed).toBe(true);
  expect(result.warning).toMatch(/company refresh failed/);
  expect(readRevision(result.root)).toBe("first");
  rmSync(remote.root, { recursive: true, force: true });
});

test.each(["^1.2.3", "latest", "workspace:*", "file:../wagglebot"])(
  "base validation rejects a non-exact pin: %s",
  (pin) => {
    const root = mkdtempSync(join(tmpdir(), "wgl-company-base-"));
    writeCandidate(root, "invalid", { pin });

    expect(() => validateCompanyBase(root)).toThrow(/exact version/);
  },
);

test("a failed refresh returns the previous active cache", async () => {
  const remote = makeRemote();
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "wgl-company-home-")));
  await refreshCompanyCache({ url: remote.remote, paths, exec: realExec });

  const result = await refreshCompanyCache({ url: join(remote.root, "missing.git"), paths, exec: realExec });

  expect(result).toMatchObject({ root: paths.activeCompanyDir, refreshFailed: true });
  expect(readRevision(result.root)).toBe("first");
  rmSync(remote.root, { recursive: true, force: true });
});

test("a failed subdirectory refresh returns the selected stale cache", async () => {
  const remote = makeRemote();
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "wgl-company-home-")));
  pushCandidate(remote.source, "reference", { subdirectory: "examples/reference-setup" });
  await refreshCompanyCache({
    url: remote.remote,
    subdirectory: "examples/reference-setup",
    paths,
    exec: realExec,
  });

  const result = await refreshCompanyCache({
    url: join(remote.root, "missing.git"),
    subdirectory: "examples/reference-setup",
    paths,
    exec: realExec,
  });

  expect(result).toMatchObject({ root: join(paths.activeCompanyDir, "examples/reference-setup"), refreshFailed: true });
  expect(readRevision(result.root)).toBe("reference");
  rmSync(remote.root, { recursive: true, force: true });
});

test("a root credential migrates when a later revision selects a company subdirectory", async () => {
  const remote = makeRemote();
  const home = mkdtempSync(join(tmpdir(), "wgl-company-home-"));
  const paths = resolvePaths(home);
  await refreshCompanyCache({ url: remote.remote, paths, exec: realExec });
  writeFileSync(join(paths.activeCompanyDir, ".env.credentials"), "TOKEN=root-fixture\n");
  pushCandidate(remote.source, "reference", { subdirectory: "examples/reference-setup" });

  const result = await refreshCompanyCache({
    url: remote.remote,
    subdirectory: "examples/reference-setup",
    paths,
    exec: realExec,
  });

  expect(readFileSync(paths.credentialsFile, "utf8")).toBe("TOKEN=root-fixture\n");
  recordCachedShellReady(paths, result.root);
  expect(result.settleCredentials?.()).toBe(true);
  expect(existsSync(join(paths.activeCompanyDir, ".env.credentials"))).toBe(false);
  rmSync(remote.root, { recursive: true, force: true });
});

test("a failed first refresh throws and does not provision a cache", async () => {
  const remote = makeRemote();
  const home = mkdtempSync(join(tmpdir(), "wgl-company-home-"));
  const paths = resolvePaths(home);

  await expect(refreshCompanyCache({ url: join(remote.root, "missing.git"), paths, exec: realExec })).rejects.toThrow(
    /company refresh failed/,
  );

  expect(existsSync(paths.companyDir)).toBe(false);
  rmSync(remote.root, { recursive: true, force: true });
});

test("an activation failure keeps the prior active link usable", async () => {
  const remote = makeRemote();
  const paths = resolvePaths(mkdtempSync(join(tmpdir(), "wgl-company-home-")));
  await refreshCompanyCache({ url: remote.remote, paths, exec: realExec });
  pushCandidate(remote.source, "second");
  mkdirSync(join(paths.companyDir, "active.next"));
  writeFileSync(join(paths.activeCompanyDir, ".env.credentials"), "FIXTURE_TOKEN=synthetic-only\n");
  const loadLegacy = () =>
    execFileSync(
      "bash",
      ["-c", '. "$WAGGLEBOT_COMPANY_REPO/.env.credentials"; test "$FIXTURE_TOKEN" = synthetic-only'],
      { env: { WAGGLEBOT_COMPANY_REPO: paths.activeCompanyDir } },
    );
  expect(loadLegacy().length).toBe(0);

  const result = await refreshCompanyCache({ url: remote.remote, paths, exec: realExec });

  expect(result.refreshFailed).toBe(true);
  expect(loadLegacy().length).toBe(0);
  expect(readRevision(paths.activeCompanyDir)).toBe("first");
  expect(lstatSync(paths.activeCompanyDir).isSymbolicLink()).toBe(true);
  rmSync(remote.root, { recursive: true, force: true });
});
