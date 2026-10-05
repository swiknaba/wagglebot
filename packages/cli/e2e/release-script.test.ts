import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./helper";

test("release aborts before tag, push, or GitHub release when the reference pin misses its target", () => {
  const root = mkdtempSync(join(tmpdir(), "wagglebot-release-preflight-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  try {
    mkdirSync(bin);
    const executable = (name: string, source: string): void => {
      const path = join(bin, name);
      writeFileSync(path, source, { mode: 0o755 });
      chmodSync(path, 0o755);
    };
    executable(
      "git",
      `#!/bin/sh\necho "git $*" >> "$RELEASE_CALLS"\ncase "$1" in\n  status) exit 0 ;;\n  branch) echo main ;;\n  rev-list) echo fixture ;;\n  describe) echo v0.3.2 ;;\n  pull|fetch) exit 0 ;;\n  tag|push) exit 97 ;;\nesac\n`,
    );
    executable("gh", `#!/bin/sh\necho "gh $*" >> "$RELEASE_CALLS"\n[ "$1 $2" = "auth status" ] && exit 0\nexit 98\n`);
    executable(
      "node",
      `#!/bin/sh\ncase "$*" in\n  *examples/reference-setup*) echo 0.3.2 ;;\n  *) echo 0.3.3 ;;\nesac\n`,
    );
    executable("bun", "#!/bin/sh\nexit 99\n");

    const result = spawnSync("bash", ["bin/release"], {
      cwd: repoRoot,
      encoding: "utf8",
      input: "3\n",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_CALLS: calls },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("reference setup version (0.3.2) does not match the release (0.3.3)");
    const recorded = readFileSync(calls, "utf8");
    expect(recorded).not.toMatch(/git (tag|push)|gh release/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
