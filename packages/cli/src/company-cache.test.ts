import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshCompanyCache, validateCompanyBase } from "./company-cache";
import { realExec } from "./exec";
import { resolvePaths } from "./paths";

const runGit = (cwd: string, args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
};

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
  runGit(source, ["remote", "add", "origin", remote]);
  runGit(source, ["push", "-u", "origin", "main"]);
  return { root, source, remote };
};

const writeCandidate = (
  root: string,
  revision: string,
  options: { marker?: boolean; company?: boolean; pin?: string } = {},
) => {
  if (options.marker !== false) writeFileSync(join(root, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: options.pin ?? "1.2.3" } }));
  if (options.company !== false) {
    mkdirSync(join(root, "company"), { recursive: true });
    writeFileSync(join(root, "company", ".keep"), "");
  }
  writeFileSync(join(root, "revision.txt"), revision);
};

const pushCandidate = (
  source: string,
  revision: string,
  options: { marker?: boolean; company?: boolean; pin?: string } = {},
) => {
  runGit(source, ["rm", "-rf", "."]);
  writeCandidate(source, revision, options);
  runGit(source, ["add", "-A"]);
  runGit(source, ["-c", "commit.gpgsign=false", "commit", "-m", revision]);
  runGit(source, ["push", "origin", "main"]);
};

const readRevision = (root: string) => readFileSync(join(root, "revision.txt"), "utf8");

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

  const result = await refreshCompanyCache({ url: remote.remote, paths, exec: realExec });

  expect(result.refreshFailed).toBe(true);
  expect(readRevision(paths.activeCompanyDir)).toBe("first");
  expect(lstatSync(paths.activeCompanyDir).isSymbolicLink()).toBe(true);
  rmSync(remote.root, { recursive: true, force: true });
});
