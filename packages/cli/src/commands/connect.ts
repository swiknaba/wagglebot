import { chmodSync, existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic-write";
import type { Reporter } from "../report";

function loadConfig(configFile: string): Record<string, unknown> {
  if (!existsSync(configFile)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configFile, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("configuration must be a JSON object");
  }
  return { ...(parsed as Record<string, unknown>) };
}

export function runConnect(input: { url: string; configFile: string; reporter: Reporter }): number {
  input.reporter.section("Connect company repository");
  try {
    const config = loadConfig(input.configFile);
    const existed = existsSync(input.configFile);
    config.companyRepository = input.url;
    writeFileAtomic(input.configFile, `${JSON.stringify(config, null, 2)}\n`);
    chmodSync(input.configFile, 0o600);
    input.reporter.item("company repository", existed ? "updated" : "installed", "saved to local configuration");
    return 0;
  } catch (error) {
    input.reporter.item(
      "company repository",
      "failed",
      error instanceof Error ? error.message : "configuration could not be saved",
    );
    return 1;
  }
}
