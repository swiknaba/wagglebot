import { LocalBrainError } from "../path-policy";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

export type GitRunResult = { stdout: string; stderr: string; exitCode: number };
export type GitSpawn = (command: string, args: string[], cwd: string) => Promise<GitRunResult>;

const bunSpawn: GitSpawn = async (command, args, cwd) => {
  const process = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => process.kill(), TIMEOUT_MS);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
};

export class GitRunner {
  constructor(private readonly spawn: GitSpawn = bunSpawn) {}

  async run(cwd: string, args: string[]): Promise<string> {
    const result = await this.spawn("git", args, cwd);
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES) {
      throw new LocalBrainError("local_brain_internal", "Git output exceeds the local limit");
    }
    if (result.exitCode !== 0) throw new LocalBrainError("local_brain_internal", "Git operation failed");
    return result.stdout;
  }
}
