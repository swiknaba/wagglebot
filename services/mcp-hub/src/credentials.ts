import { createHash } from "node:crypto";
import type { CredentialSource, ProxyConfig } from "@wagglebot/contracts";

export type ResolvedCredential = { value: string; fingerprint: string };
export async function resolveCredential(
  source: CredentialSource,
  input: {
    registryOrigin: "local" | "remote";
    env: Record<string, string | undefined>;
    readFile: (path: string) => Promise<string>;
  },
): Promise<ResolvedCredential | null> {
  if (source.from === "env") {
    const value = input.env[source.var];
    if (!value) return null;
    return { value, fingerprint: createHash("sha256").update(value).digest("hex") };
  }
  const value = (await input.readFile(source.path)).replace(/\r?\n$/, "");
  if (!value) return null;
  return { value, fingerprint: createHash("sha256").update(value).digest("hex") };
}
export function explicitChildEnv(proxy: ProxyConfig, env: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, expansion] of Object.entries(proxy.env ?? {})) {
    const variable = expansion.slice(2, -1);
    const value = env[variable];
    if (value !== undefined) output[key] = value;
  }
  return output;
}
