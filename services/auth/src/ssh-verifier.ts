import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D26_SIGNATURE_NAMESPACE } from "@wagglebot/d26-auth";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface SshSignatureVerifier {
  verify(input: {
    payload: Uint8Array;
    signature: string;
    username: string;
    authorizedKey: string;
    signal: AbortSignal;
  }): Promise<boolean>;
}

export class OpenSshSignatureVerifier implements SshSignatureVerifier {
  private readonly sshKeygenPath: string;
  private readonly timeoutMs: number;

  constructor(options: { sshKeygenPath?: string; timeoutMs?: number } = {}) {
    this.sshKeygenPath = options.sshKeygenPath ?? "ssh-keygen";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async verify(input: {
    payload: Uint8Array;
    signature: string;
    username: string;
    authorizedKey: string;
    signal: AbortSignal;
  }): Promise<boolean> {
    if (input.signal.aborted) return false;
    const stdinPayload = Uint8Array.from(input.payload);
    let directory: string | undefined;
    let processHandle: Bun.Subprocess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "wagglebot-auth-verify-"));
      const allowedSignersPath = join(directory, "allowed-signers");
      const signaturePath = join(directory, "signature");
      const payloadPath = join(directory, "payload");
      await Promise.all([
        writeFile(allowedSignersPath, `${input.username} ${input.authorizedKey}\n`, { mode: 0o600 }),
        writeFile(signaturePath, input.signature, { mode: 0o600 }),
        writeFile(payloadPath, input.payload, { mode: 0o600 }),
      ]);
      await Promise.all([chmod(allowedSignersPath, 0o600), chmod(signaturePath, 0o600), chmod(payloadPath, 0o600)]);
      processHandle = Bun.spawn(
        [
          this.sshKeygenPath,
          "-Y",
          "verify",
          "-f",
          allowedSignersPath,
          "-I",
          input.username,
          "-n",
          D26_SIGNATURE_NAMESPACE,
          "-s",
          signaturePath,
        ],
        { stdin: new Blob([stdinPayload]), stdout: "ignore", stderr: "ignore" },
      );
      abort = () => processHandle?.kill();
      input.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => processHandle?.kill(), this.timeoutMs);
      return (await processHandle.exited) === 0 && !input.signal.aborted;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) input.signal.removeEventListener("abort", abort);
      processHandle?.kill();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
