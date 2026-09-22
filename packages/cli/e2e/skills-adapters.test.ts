import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillsBin } from "../src/commands/install-skills";
import { HARNESSES } from "../src/harness";

test("the installed skills CLI accepts every declared adapter and rejects an invalid adapter offline", async () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-skills-adapters-"));
  try {
    const require = createRequire(import.meta.url);
    expect(require("skills/package.json").version).toBe("1.5.23");
    const bin = resolveSkillsBin();
    if (bin === undefined) throw new Error("The installed skills CLI is missing.");
    const adapters = HARNESSES.flatMap((h) => h.skillsAgents);
    expect(adapters).toEqual([
      "claude-code",
      "codex",
      "junie",
      "gemini-cli",
      "github-copilot",
      "cline",
      "cursor",
      "devin",
      "windsurf",
      "kiro-cli",
    ]);
    for (const adapter of [...adapters, "wagglebot-invalid-control"]) {
      const child = Bun.spawn([process.execPath, bin, "ls", "--global", "--agent", adapter, "--json"], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          DISABLE_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
          CI: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ adapter, code, output: code === 0 ? "" : `${stdout}${stderr}` }).toMatchObject({
        adapter,
        code: adapter === "wagglebot-invalid-control" ? 1 : 0,
      });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
