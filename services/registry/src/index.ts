import { readFile } from "node:fs/promises";
import { verifyAuthSessionToken } from "@wagglebot/auth-protocol";
import { importSPKI } from "jose";
import { loadRegistryConfig } from "./config";
import { createApp } from "./http";
import { RegistrySource } from "./source";

export async function createServer(env: Record<string, string | undefined> = process.env) {
  const config = loadRegistryConfig(env);
  const publicKey = await importSPKI(await readFile(config.authPublicKeyFile, "utf8"), "EdDSA");
  const source = new RegistrySource({ companyRoot: config.companyRoot, sourceRevision: config.sourceRevision });
  await source.refresh();
  const app = createApp({
    source,
    maxResponseBytes: config.maxResponseBytes,
    verify: (token) =>
      verifyAuthSessionToken(token, { issuer: config.issuer, audience: "wagglebot-registry", publicKey }),
  });
  setInterval(() => void source.refresh(), config.refreshSeconds * 1_000);
  return Bun.serve({ hostname: config.bindHost, port: config.port, fetch: app.fetch });
}

if (import.meta.main) await createServer();
