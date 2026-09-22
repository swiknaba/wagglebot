import { join } from "node:path";

export type WagglePaths = {
  stateDir: string;
  managedFile: string;
  backupsDir: string;
  agentsCacheDir: string;
  configFile: string;
  companyDir: string;
  activeCompanyDir: string;
  credentialsFile: string;
  runtimeDir: string;
};

export function resolvePaths(home: string): WagglePaths {
  const stateDir = join(home, ".wagglebot");
  return {
    stateDir,
    managedFile: join(stateDir, "managed.json"),
    backupsDir: join(stateDir, "backups"),
    agentsCacheDir: join(stateDir, "agents-cache"),
    configFile: join(stateDir, "config.json"),
    companyDir: join(stateDir, "company"),
    activeCompanyDir: join(stateDir, "company", "active"),
    credentialsFile: join(stateDir, ".env.credentials"),
    runtimeDir: join(stateDir, "runtime"),
  };
}
