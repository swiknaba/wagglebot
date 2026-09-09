import { execFile } from "node:child_process";

// notFound: the command itself does not exist. A program that exits with 127 is a normal failure.
export type ExecResult = { code: number; stdout: string; stderr: string; notFound?: true };
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
      const notFound = error !== null && error.code === "ENOENT";
      resolve({ code, stdout: String(stdout), stderr: String(stderr), ...(notFound ? { notFound: true } : {}) });
    });
  });
