import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templatesDir } from "../harness";
import type { Reporter } from "../report";

const RENAMES: Record<string, string> = {
  gitignore: ".gitignore",
  "env.credentials.example": ".env.credentials.example",
};
const SUBSTITUTED = new Set(["package.json", "README.md"]);

export function runInit(deps: { targetDir: string; version: string; reporter: Reporter }): number {
  const { targetDir, reporter } = deps;
  reporter.section("Scaffold company repository");
  mkdirSync(targetDir, { recursive: true });
  const offending = readdirSync(targetDir).find((entry) => entry !== ".git");
  if (offending !== undefined) {
    reporter.item(targetDir, "failed", `directory is not empty ("${offending}") — init refuses to overwrite`);
    return 1;
  }
  const source = join(templatesDir(), "init");
  cpSync(source, targetDir, { recursive: true });
  for (const [from, to] of Object.entries(RENAMES)) {
    if (existsSync(join(targetDir, from))) renameSync(join(targetDir, from), join(targetDir, to));
  }
  for (const file of SUBSTITUTED) {
    const path = join(targetDir, file);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("{{WAGGLEBOT_VERSION}}", deps.version));
  }
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
    );
  for (const file of walk(targetDir, "").filter((f) => !f.startsWith(".git/"))) reporter.item(file, "installed");
  return 0;
}
