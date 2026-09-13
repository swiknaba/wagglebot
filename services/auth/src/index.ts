import { createCatalogPublicKeyResolver, createGitHubPublicKeyResolver, type PublicKeyResolver } from "./catalog-keys";
import { InMemoryChallengeStore } from "./challenge-store";
import { type AuthConfig, loadAuthConfig } from "./config";
import { createApp } from "./http";
import { AuthIssuer, loadIssuerSigningKey } from "./issuer";
import { OpenSshSignatureVerifier } from "./ssh-verifier";

export async function createServer(config: AuthConfig) {
  const keyResolver = createKeyResolver(config);
  if (config.keySource === "catalog") {
    await keyResolver.refresh(new AbortController().signal).catch(() => undefined);
  }
  const signingKey = await loadIssuerSigningKey(config.signingPrivateKeyFile);
  const issuer = new AuthIssuer({
    issuer: config.issuer,
    signingKey,
    challenges: new InMemoryChallengeStore(),
    keyResolver,
    verifier: new OpenSshSignatureVerifier(),
  });
  const app = createApp({
    issuer,
    readiness: () => ({
      catalog: config.keySource === "github" || keyResolver.ready() ? "ready" : "unavailable",
      signingKey: "ready",
    }),
  });
  return Bun.serve({ hostname: config.bindHost, port: config.port, fetch: app.fetch });
}

function createKeyResolver(config: AuthConfig): PublicKeyResolver {
  if (config.keySource === "catalog") return createCatalogPublicKeyResolver({ catalogPath: config.catalogPath });
  return createGitHubPublicKeyResolver({ githubKeysHost: config.githubKeysHost as string });
}

if (import.meta.main) {
  await createServer(loadAuthConfig());
}
