import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// Walks up from cwd to the first directory that holds .git. A worktree or a submodule keeps a
// .git file instead of a directory, and both count. No .git anywhere is a hard error, because
// the command has no other way to find the repository. The result is canonical: symlinks resolved.
export function findProjectRoot(cwd: string): string {
  let dir = realpathSync(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no Git repository found from ${cwd}. Run sync-project inside a repository.`);
    dir = parent;
  }
}
