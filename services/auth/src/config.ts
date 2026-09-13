import { z } from "zod";

export type AuthConfig = {
  bindHost: string;
  port: number;
  issuer: string;
  signingPrivateKeyFile: string;
  catalogPath: string;
  catalogRefreshSeconds: number;
  keySource: "catalog" | "github";
  githubKeysHost?: string;
  challengeTtlSeconds: 60;
  sessionTtlSeconds: 900;
  clockSkewSeconds: 30;
  maxAttemptsPerChallenge: 3;
  rateLimitWindowSeconds: 60;
  maxChallengesPerWindow: 10;
};

const environmentSchema = z
  .object({
    D26_AUTH_HOST: z.string().min(1),
    D26_AUTH_PORT: z.coerce.number().int().min(1).max(65_535),
    D26_AUTH_ISSUER: z.url().refine((value) => new URL(value).protocol === "https:"),
    D26_AUTH_SIGNING_PRIVATE_KEY_FILE: z.string().min(1),
    D26_AUTH_CATALOG_PATH: z.string().min(1),
    D26_AUTH_CATALOG_REFRESH_SECONDS: z.coerce.number().int().min(1).max(86_400),
    D26_AUTH_KEY_SOURCE: z.enum(["catalog", "github"]),
    D26_AUTH_GITHUB_KEYS_HOST: z.string().min(1).optional(),
  })
  .superRefine((environment, context) => {
    if (environment.D26_AUTH_KEY_SOURCE === "github" && !environment.D26_AUTH_GITHUB_KEYS_HOST) {
      context.addIssue({ code: "custom", message: "GitHub key source requires a host" });
    }
  });

export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) throw new Error("invalid D26 auth configuration");
  return {
    bindHost: parsed.data.D26_AUTH_HOST,
    port: parsed.data.D26_AUTH_PORT,
    issuer: parsed.data.D26_AUTH_ISSUER,
    signingPrivateKeyFile: parsed.data.D26_AUTH_SIGNING_PRIVATE_KEY_FILE,
    catalogPath: parsed.data.D26_AUTH_CATALOG_PATH,
    catalogRefreshSeconds: parsed.data.D26_AUTH_CATALOG_REFRESH_SECONDS,
    keySource: parsed.data.D26_AUTH_KEY_SOURCE,
    ...(parsed.data.D26_AUTH_GITHUB_KEYS_HOST ? { githubKeysHost: parsed.data.D26_AUTH_GITHUB_KEYS_HOST } : {}),
    challengeTtlSeconds: 60,
    sessionTtlSeconds: 900,
    clockSkewSeconds: 30,
    maxAttemptsPerChallenge: 3,
    rateLimitWindowSeconds: 60,
    maxChallengesPerWindow: 10,
  };
}
