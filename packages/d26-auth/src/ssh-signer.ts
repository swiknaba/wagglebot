import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { D26_SIGNATURE_NAMESPACE } from "./canonical-challenge";
import type { SshSigner } from "./types";

const DEFAULT_TIMEOUT_MS = 5_000;

export class SshAgentSigner implements SshSigner {
  private readonly publicKeyPath: string;
  private readonly sshKeygenPath: string;
  private readonly timeoutMs: number;

  constructor(options: { publicKeyPath: string; sshKeygenPath?: string; timeoutMs?: number }) {
    this.publicKeyPath = options.publicKeyPath;
    this.sshKeygenPath = options.sshKeygenPath ?? "ssh-keygen";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sign(payload: Uint8Array, signal: AbortSignal): Promise<string> {
    if (!process.env.SSH_AUTH_SOCK) throw new Error("ssh-agent is unavailable");
    if (signal.aborted) throw new Error("SSH signing was aborted");

    const keyPath = await this.safePublicKeyPath();
    const directory = await mkdtemp(join(tmpdir(), "wagglebot-auth-"));
    const payloadPath = join(directory, "challenge");
    const signaturePath = `${payloadPath}.sig`;
    let processHandle: Bun.Subprocess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await writeFile(payloadPath, payload, { mode: 0o600 });
      await chmod(payloadPath, 0o600);
      processHandle = Bun.spawn(
        [this.sshKeygenPath, "-Y", "sign", "-f", keyPath, "-n", D26_SIGNATURE_NAMESPACE, "-U", payloadPath],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );

      const abort = () => processHandle?.kill();
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => processHandle?.kill(), this.timeoutMs);
      const exitCode = await processHandle.exited;
      signal.removeEventListener("abort", abort);
      if (signal.aborted) throw new Error("SSH signing was aborted");
      if (exitCode !== 0) throw new Error("SSH signing failed");

      const signature = (await readFile(signaturePath, "utf8")).trim();
      if (!signature) throw new Error("SSH signing failed");
      return signature;
    } catch (error) {
      if (error instanceof Error && ["SSH signing was aborted", "SSH signing failed"].includes(error.message))
        throw error;
      throw new Error("SSH signing failed");
    } finally {
      if (timer) clearTimeout(timer);
      if (processHandle) processHandle.kill();
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async safePublicKeyPath(): Promise<string> {
    try {
      const resolved = await realpath(this.publicKeyPath);
      const allowedRoots = [homedir(), process.cwd()].map((root) => resolve(root) + sep);
      if (!allowedRoots.some((root) => resolved.startsWith(root))) throw new Error("outside allowed roots");
      return resolved;
    } catch {
      throw new Error("public key is unavailable");
    }
  }
}
