import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec";
import { ensurePinnedRuntime, runPinnedRuntime } from "./pinned-runtime";

const temporaryRoots: string[] = [];

const makeRuntimeDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wgl-pinned-runtime-"));
  temporaryRoots.push(root);
  return join(root, "runtime");
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const installResult = (runtimePath: string, complete = true) => {
  if (complete) {
    mkdirSync(join(runtimePath, "node_modules/wagglebot/bin"), { recursive: true });
    writeFileSync(join(runtimePath, "node_modules/wagglebot/bin/wagglebot.js"), "#!/usr/bin/env node\n");
  } else {
    mkdirSync(runtimePath, { recursive: true });
  }
  return { code: 0, stdout: "installed\n", stderr: "" };
};

test("reuses a complete installed version without invoking npm", async () => {
  const runtimeDir = makeRuntimeDir();
  const versionDir = join(runtimeDir, "1.2.3");
  installResult(versionDir);
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 99, stdout: "", stderr: "must not run" };
  };

  await expect(ensurePinnedRuntime({ pin: "1.2.3", runtimeDir, exec })).resolves.toEqual({
    version: "1.2.3",
    bin: join(versionDir, "node_modules/wagglebot/bin/wagglebot.js"),
  });
  expect(calls).toEqual([]);
});

test("installs a missing version into a temporary directory and activates it", async () => {
  const runtimeDir = makeRuntimeDir();
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const candidate = args[2];
    if (cmd !== "npm" || args[0] !== "install" || candidate === undefined) throw new Error("unexpected command");
    return installResult(candidate);
  };

  const result = await ensurePinnedRuntime({ pin: "2.3.4", runtimeDir, exec });

  const versionDir = join(runtimeDir, "2.3.4");
  expect(result).toEqual({ version: "2.3.4", bin: join(versionDir, "node_modules/wagglebot/bin/wagglebot.js") });
  expect(calls).toHaveLength(1);
  const npmCall = calls[0];
  if (npmCall === undefined) throw new Error("npm was not called");
  const candidate = npmCall[3];
  if (candidate === undefined) throw new Error("npm prefix was not provided");
  expect(npmCall.slice(0, 2)).toEqual(["npm", "install"]);
  expect(npmCall.slice(2)).toEqual(["--prefix", candidate, "--no-save", "--no-package-lock", "wagglebot@2.3.4"]);
  expect(candidate).not.toBe(versionDir);
  expect(existsSync(versionDir)).toBe(true);
});

test("reports a failed npm install and leaves no runtime", async () => {
  const runtimeDir = makeRuntimeDir();
  const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "registry unavailable" });

  await expect(ensurePinnedRuntime({ pin: "3.4.5", runtimeDir, exec })).rejects.toThrow(
    "pinned runtime install failed: registry unavailable",
  );
  expect(existsSync(join(runtimeDir, "3.4.5"))).toBe(false);
});

test("replaces an incomplete installed version only after npm creates a complete runtime", async () => {
  const runtimeDir = makeRuntimeDir();
  const versionDir = join(runtimeDir, "4.5.6");
  installResult(versionDir, false);
  const exec: Exec = async (_cmd, args) => installResult(args[2] ?? "");

  const result = await ensurePinnedRuntime({ pin: "4.5.6", runtimeDir, exec });

  expect(result.bin).toBe(join(versionDir, "node_modules/wagglebot/bin/wagglebot.js"));
  expect(existsSync(result.bin)).toBe(true);
});

test("rejects an npm result that does not contain the Wagglebot entry point", async () => {
  const runtimeDir = makeRuntimeDir();
  const exec: Exec = async (_cmd, args) => installResult(args[2] ?? "", false);

  await expect(ensurePinnedRuntime({ pin: "5.6.7", runtimeDir, exec })).rejects.toThrow(
    "pinned runtime install produced an incomplete package",
  );
  expect(existsSync(join(runtimeDir, "5.6.7"))).toBe(false);
});

test("runs the installed bin with hidden company and runtime arguments", async () => {
  const lines: string[] = [];
  let call: string[] | undefined;
  const exec: Exec = async (cmd, args) => {
    call = [cmd, ...args];
    return { code: 7, stdout: "child stdout", stderr: "child stderr" };
  };

  const code = await runPinnedRuntime({
    runtime: { version: "6.7.8", bin: "/tmp/runtime/bin/wagglebot.js" },
    argv: ["update", "--quiet"],
    companyRoot: "/tmp/company/active",
    exec,
    write: (line) => lines.push(line),
  });

  expect(call).toEqual([
    process.execPath,
    "/tmp/runtime/bin/wagglebot.js",
    "--company-root",
    "/tmp/company/active",
    "--pinned-runtime",
    "6.7.8",
    "update",
    "--quiet",
  ]);
  expect(lines).toEqual(["child stdout", "child stderr"]);
  expect(code).toBe(7);
});

test("an interactive runtime owns its output and preserves its exit status without buffered execution", async () => {
  const lines: string[] = [];
  let call: string[] | undefined;
  const code = await runPinnedRuntime({
    runtime: { version: "6.7.8", bin: "/tmp/runtime/bin/wagglebot.js" },
    argv: ["update", "--wagglebot"],
    companyRoot: "/tmp/company/active",
    sourceFailed: true,
    exec: async () => {
      throw new Error("Buffered execution cannot accept a username");
    },
    interactiveExec: async (cmd: string, args: string[]) => {
      call = [cmd, ...args];
      return 17;
    },
    write: (line) => lines.push(line),
  });
  expect(call).toEqual([
    process.execPath,
    "/tmp/runtime/bin/wagglebot.js",
    "--company-root",
    "/tmp/company/active",
    "--pinned-runtime",
    "6.7.8",
    "--source-failed",
    "update",
    "--wagglebot",
  ]);
  expect(code).toBe(17);
  expect(lines).toEqual([]);
});

test("passes stale source failure state to the child runtime", async () => {
  let args: string[] | undefined;
  const exec: Exec = async (cmd, received) => {
    args = [cmd, ...received];
    return { code: 0, stdout: "", stderr: "" };
  };

  await runPinnedRuntime({
    runtime: { version: "7.8.9", bin: "/tmp/runtime/bin/wagglebot.js" },
    argv: ["update"],
    companyRoot: "/tmp/company/active",
    sourceFailed: true,
    exec,
    write: () => {},
  });

  expect(args).toEqual([
    process.execPath,
    "/tmp/runtime/bin/wagglebot.js",
    "--company-root",
    "/tmp/company/active",
    "--pinned-runtime",
    "7.8.9",
    "--source-failed",
    "update",
  ]);
});

test.each([
  [
    "separate-token duplicates",
    ["update", "--company-root", "/tmp/evil", "--pinned-runtime", "0.0.0", "--source-failed", "--quiet"],
  ],
  [
    "equals-form duplicates",
    ["update", "--company-root=/tmp/evil", "--pinned-runtime=0.0.0", "--source-failed=true", "--quiet"],
  ],
])("removes reserved hidden argument %s from caller arguments", async (_description, argv) => {
  let args: string[] | undefined;
  const exec: Exec = async (cmd, received) => {
    args = [cmd, ...received];
    return { code: 0, stdout: "", stderr: "" };
  };

  await runPinnedRuntime({
    runtime: { version: "8.9.0", bin: "/tmp/runtime/bin/wagglebot.js" },
    argv,
    companyRoot: "/tmp/company/active",
    sourceFailed: false,
    exec,
    write: () => {},
  });

  expect(args).toEqual([
    process.execPath,
    "/tmp/runtime/bin/wagglebot.js",
    "--company-root",
    "/tmp/company/active",
    "--pinned-runtime",
    "8.9.0",
    "update",
    "--quiet",
  ]);
});

test.each(["--company-root", "--pinned-runtime"])(
  "preserves an ordinary option after a missing value for %s",
  async (reservedOption) => {
    let args: string[] | undefined;
    const exec: Exec = async (cmd, received) => {
      args = [cmd, ...received];
      return { code: 0, stdout: "", stderr: "" };
    };

    await runPinnedRuntime({
      runtime: { version: "8.9.0", bin: "/tmp/runtime/bin/wagglebot.js" },
      argv: ["update", reservedOption, "--quiet"],
      companyRoot: "/tmp/company/active",
      exec,
      write: () => {},
    });

    expect(args).toEqual([
      process.execPath,
      "/tmp/runtime/bin/wagglebot.js",
      "--company-root",
      "/tmp/company/active",
      "--pinned-runtime",
      "8.9.0",
      "update",
      "--quiet",
    ]);
  },
);
