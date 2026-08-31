import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Exec } from "../exec";
import { parseList } from "../lists";
import type { Reporter } from "../report";

export function resolveSkillsBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("skills/package.json");
  const pkg: { bin: string | Record<string, string> } = require("skills/package.json");
  const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.skills ?? Object.values(pkg.bin)[0] ?? "");
  return join(dirname(pkgPath), rel);
}

export async function runInstallSkills(deps: {
  listText: string | undefined;
  listPath: string;
  exec: Exec;
  reporter: Reporter;
  skillsBin: string;
  update?: boolean;
  writeList?: (text: string) => void;
}): Promise<number> {
  const { reporter } = deps;
  reporter.section("Skills");
  if (deps.listText === undefined) {
    reporter.item(deps.listPath, "skipped", "file not found");
    return 0;
  }
  const { entries, warnings } = parseList(deps.listText);
  for (const w of warnings) reporter.item(w, "skipped", "warning only");

  if (deps.update === true) {
    let text = deps.listText;
    for (const entry of entries.filter((e) => e.ref !== undefined)) {
      const remote = await deps.exec("git", ["ls-remote", `https://github.com/${entry.repo}.git`, "HEAD"]);
      const hash = remote.stdout.slice(0, 40);
      if (remote.code !== 0 || !/^[0-9a-f]{40}$/.test(hash)) {
        reporter.item(entry.repo, "failed", "could not resolve remote HEAD");
        continue;
      }
      text = text.replace(entry.raw, `${entry.repo}@${hash}`);
      reporter.item(entry.repo, "updated", `pin -> ${hash.slice(0, 12)}`);
    }
    deps.writeList?.(text);
    return reporter.failed() ? 1 : 0;
  }

  for (const entry of entries) {
    const result = await deps.exec(deps.skillsBin, ["add", entry.raw, "-g", "-y"]);
    if (result.code !== 0) reporter.item(entry.raw, "failed", result.stderr.split("\n")[0] ?? "");
    else if (result.stdout.includes("already")) reporter.item(entry.raw, "ok", "already installed");
    else reporter.item(entry.raw, "installed");
  }
  return reporter.failed() ? 1 : 0;
}
