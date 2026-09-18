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
    AUTH_HOST: z.string().min(1),
    AUTH_PORT: z.coerce.number().int().min(1).max(65_535),
    AUTH_ISSUER: z.url().refine((value) => new URL(value).protocol === "https:"),
    AUTH_SIGNING_PRIVATE_KEY_FILE: z.string().min(1),
    AUTH_CATALOG_PATH: z.string().min(1),
    AUTH_CATALOG_REFRESH_SECONDS: z.coerce.number().int().min(1).max(86_400),
    AUTH_KEY_SOURCE: z.enum(["catalog", "github"]),
    AUTH_GITHUB_KEYS_HOST: z.string().min(1).optional(),
  })
  .superRefine((environment, context) => {
    if (environment.AUTH_KEY_SOURCE === "github" && !environment.AUTH_GITHUB_KEYS_HOST) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_GITHUB_KEYS_HOST"],
        message: "is required for GitHub key source",
      });
    }
  });

export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${String(issue?.path[0] ?? "auth configuration")}: ${issue?.message ?? "invalid value"}`);
  }
  return {
    bindHost: parsed.data.AUTH_HOST,
    port: parsed.data.AUTH_PORT,
    issuer: parsed.data.AUTH_ISSUER,
    signingPrivateKeyFile: parsed.data.AUTH_SIGNING_PRIVATE_KEY_FILE,
    catalogPath: parsed.data.AUTH_CATALOG_PATH,
    catalogRefreshSeconds: parsed.data.AUTH_CATALOG_REFRESH_SECONDS,
    keySource: parsed.data.AUTH_KEY_SOURCE,
    ...(parsed.data.AUTH_GITHUB_KEYS_HOST ? { githubKeysHost: parsed.data.AUTH_GITHUB_KEYS_HOST } : {}),
    challengeTtlSeconds: 60,
    sessionTtlSeconds: 900,
    clockSkewSeconds: 30,
    maxAttemptsPerChallenge: 3,
    rateLimitWindowSeconds: 60,
    maxChallengesPerWindow: 10,
  };
}
