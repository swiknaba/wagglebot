import { createHash } from "node:crypto";
import { resolveProjectPath } from "../path-policy";

export const resolveProjectRootKey = async (projectPath: string): Promise<{ root: string; rootKey: string }> => {
  const project = await resolveProjectPath(projectPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const digest = createHash("sha256")
    .update(`wagglebot-context-root-v1\0${uid}\0${project.root}`)
    .digest("hex")
    .slice(0, 32);
  return { root: project.root, rootKey: `rk_${digest}` };
};
