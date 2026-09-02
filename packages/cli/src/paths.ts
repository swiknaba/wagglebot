import { join } from "node:path";

export type WagglePaths = {
  stateDir: string;
  managedFile: string;
  backupsDir: string;
  agentsCacheDir: string;
};

export function resolvePaths(home: string): WagglePaths {
  const stateDir = join(home, ".wagglebot");
  return {
    stateDir,
    managedFile: join(stateDir, "managed.json"),
    backupsDir: join(stateDir, "backups"),
    agentsCacheDir: join(stateDir, "agents-cache"),
  };
}
