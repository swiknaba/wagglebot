. the# D26 SSH Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (or `superpowers:subagent-driven-development` when the work is split into independent tasks) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement D26 so a registered engineer proves possession of an existing SSH key, receives a short-lived audience-bound session token, and can use that token with the shared registry, memory worker, and later coordination services.

**Architecture:** A shared `services/auth` issuer creates one-time challenges, verifies OpenSSH signatures in the `wagglebot-auth@wagglebot.dev` namespace against the Backstage catalog (or the explicitly configured GitHub key source), and signs a short-lived EdDSA JWT. A workstation-side `@wagglebot/d26-auth` client signs through `ssh-agent`, exchanges the signature, caches tokens per audience, and refreshes them before expiry. Shared services verify the JWT locally with the issuer public key and derive the principal from `sub`; request fields never select identity or scopes.

**Tech Stack:** TypeScript, Bun, Zod 4, `jose` 6.2.12, existing `@wagglebot/contracts`, `yaml` 2.8.3, OpenSSH `ssh-keygen`/`ssh-agent`, Bun `fetch`, Bun tests, Biome, and the existing `createServer`/`createApp` service pattern. No private key is uploaded and no new credential-delivery system is introduced.

**Spec:** D26 in `docs/superpowers/specs/2026-08-28-wagglebot-design.md`, the identity flow in `docs/superpowers/specs/2026-08-28-phase-3-collaboration.md`, authentication requirements in `docs/superpowers/specs/2026-08-28-phase-2-shared-layer.md`, and the service contracts in `docs/superpowers/specs/2026-08-28-service-contracts.md`.

## Global Constraints

- Phase 1 remains unauthenticated. Git access is the Phase 1 access mechanism; do not add D26 to local memory, Wake, or Context Bridge.
- D26 is for shared network services only. The local MCP hub uses it when calling the shared registry or shared memory; it does not forward the D26 token to an upstream MCP server.
- The private SSH key stays on the workstation. Production signing uses `ssh-agent` and `ssh-keygen -Y sign -U`; the auth service receives only the OpenSSH signature and public-key identity lookup data.
- Use the fixed OpenSSH signature namespace `wagglebot-auth@wagglebot.dev` and sign a canonical, versioned challenge payload. Never verify an un-namespaced or caller-supplied payload.
- The server creates a cryptographically random 32-byte nonce, stores only a hash of it with the challenge record, accepts a challenge once, expires it after 60 seconds, and permits at most three signature attempts.
- Session tokens are JWTs signed with EdDSA, have a 15-minute lifetime, are audience-specific, and are refreshed when less than 60 seconds remain. Verifiers allow only `EdDSA` and require issuer, audience, `sub`, `iat`, `exp`, and `jti`.
- Allowed audiences are configured, exact strings: `wagglebot-registry`, `wagglebot-memory`, and `wagglebot-coordination`. Unknown audiences are rejected before a challenge is issued.
- The catalog is authoritative for username, public key, group membership, and org-owner annotation. Never accept groups, scopes, or principal identity from an auth request or token extension.
- Do not create `users.yaml` or a second identity database. User identity lives in the Backstage catalog, and catalog pull-request changes are the registration, key-rotation, and offboarding mechanism.
- The default key source is `wagglebot.dev/ssh-key` in the catalog. The optional GitHub source is HTTPS-only, host-pinned, cached, and never selected by a request field.
- Authentication failures use stable codes and do not reveal whether a username, key, challenge, or signature was valid. Return `401` for missing/invalid/expired credentials, `403` only after a valid token fails an operation authorization check, and `429` for rate limits.
- `/livez` is shallow and auth-exempt. `/readyz` is auth-exempt and reports catalog/key/signing readiness without secrets. All shared data endpoints remain fail-closed.
- Log only request correlation ID, audience, stable outcome/error code, and bounded timing/counts. Never log signatures, nonces, JWTs, public-key text, private-key paths, authorization headers, catalog content, or usernames in failed-auth messages.
- The issuer is one instance per signing-key/challenge store in this release. Do not claim multi-instance replay protection. A future HA deployment must move the challenge store to a shared transactional store before adding replicas.
- Add the D26 endpoint and MCP/client contracts to the complete `docs/api-reference.md` gate before Phase 2 release. This plan defines the auth section; it does not make incomplete API documentation authoritative for unrelated services.
- Treat the completed v1 request/result schemas, health/error envelopes,
  limits, replay semantics, and rate limits in `docs/api-reference.md` as the
  authoritative wire contract.
- Run `bun run check && bun run typecheck && bun test` at every green-tree checkpoint.

## Wire Decisions Made Explicit

The source documents define the D26 behavior but intentionally do not define
the wire-level endpoint names, token format, or numeric lifetimes. This plan
makes those details concrete so implementation and tests are deterministic:

- endpoints: `POST /v1/auth/challenge` and `POST /v1/auth/session`;
- token: EdDSA JWT with exact issuer and audience claims;
- challenge lifetime: 60 seconds, three signature attempts;
- session lifetime: 900 seconds, refresh threshold: 60 seconds;
- challenge body: versioned nonce envelope signed with the fixed SSHSIG
  namespace;
- auth service: an internal shared-layer service, not a new user-facing
  product or identity database.

These are compatible implementation choices, not additional product behavior.
Record them in `docs/api-reference.md` before implementation is merged. If the
API-reference review selects different paths or durations, update this plan
and the contracts together before writing code.

## Repository Map

```text
packages/contracts/src/auth.ts
packages/contracts/src/auth.test.ts
packages/contracts/src/index.ts

packages/d26-auth/package.json
packages/d26-auth/src/canonical-challenge.ts
packages/d26-auth/src/canonical-challenge.test.ts
packages/d26-auth/src/ssh-signer.ts
packages/d26-auth/src/ssh-signer.test.ts
packages/d26-auth/src/session-token.ts
packages/d26-auth/src/session-token.test.ts
packages/d26-auth/src/client.ts
packages/d26-auth/src/client.test.ts
packages/d26-auth/src/index.ts

services/auth/package.json
services/auth/Dockerfile
services/auth/src/config.ts
services/auth/src/config.test.ts
services/auth/src/catalog-keys.ts
services/auth/src/catalog-keys.test.ts
services/auth/src/challenge-store.ts
services/auth/src/challenge-store.test.ts
services/auth/src/ssh-verifier.ts
services/auth/src/ssh-verifier.test.ts
services/auth/src/issuer.ts
services/auth/src/issuer.test.ts
services/auth/src/http.ts
services/auth/src/http.test.ts
services/auth/src/index.ts
services/auth/integration/auth-e2e.test.ts

services/memory-worker/src/principal.ts
services/memory-worker/src/principal.test.ts
services/context-engine/src/shared/session-token.ts
services/context-engine/src/shared/session-token.test.ts

deploy/docker-compose.memory.yml
deploy/README.md
docs/api-reference.md
```

`packages/contracts` owns wire schemas. `packages/d26-auth` is the reusable
workstation client and token verifier/cache seam. `services/auth` owns catalog
lookup, challenge state, SSHSIG verification, and JWT issuance. Memory and
context-engine consume the package; they do not reimplement D26.

---

## Task 1: Define versioned D26 contracts

**Files:**

- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/auth.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Produces: strict schemas and inferred types for challenge/session requests,
  responses, token claims, principal metadata, and stable auth errors.
- Consumes: no runtime service.

- [ ] **Step 1: Write failing schema tests**

```typescript
import { expect, test } from "bun:test";
import {
  AuthChallengeRequestSchema,
  AuthSessionRequestSchema,
  D26SessionClaimsSchema,
} from "./auth";

test("challenge requests accept only known audiences and usernames", () => {
  expect(AuthChallengeRequestSchema.safeParse({
    schemaVersion: 1,
    username: "alice",
    audience: "wagglebot-memory",
  }).success).toBe(true);
  expect(AuthChallengeRequestSchema.safeParse({
    schemaVersion: 1,
    username: "Alice",
    audience: "wagglebot-memory",
  }).success).toBe(false);
  expect(AuthChallengeRequestSchema.safeParse({
    username: "alice",
    audience: "arbitrary-service",
  }).success).toBe(false);
});

test("session requests bound to the challenge reject oversized signatures", () => {
  expect(AuthSessionRequestSchema.safeParse({
    schemaVersion: 1,
    challengeId: "ch_0123456789abcdef0123456789",
    username: "alice",
    signature: "A".repeat(16_385),
  }).success).toBe(false);
});

test("claims require issuer, audience, principal, and bounded lifetime", () => {
  const result = D26SessionClaimsSchema.safeParse({
    iss: "https://auth.example.test",
    sub: "alice",
    aud: "wagglebot-memory",
    iat: 1_758_000_000,
    exp: 1_758_000_900,
    jti: "jti_0123456789abcdef0123456789",
  });
  expect(result.success).toBe(true);
});
```

Add tests for unknown keys, NUL/control characters, invalid challenge IDs,
invalid response formats, non-allow-listed audiences, `exp <= iat`, lifetime
over 900 seconds, empty signatures, and every stable error code.

Run: `bun test packages/contracts/src/auth.test.ts`

Expected before implementation: FAIL because `auth.ts` and its exports do not
exist.

- [ ] **Step 2: Implement closed schemas**

Use these exact public shapes:

```typescript
export const D26AudienceSchema = z.enum([
  "wagglebot-registry",
  "wagglebot-memory",
  "wagglebot-coordination",
]);

export const AuthChallengeRequestSchema = z.object({
  schemaVersion: z.literal(1),
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  audience: D26AudienceSchema,
}).strict();

export const AuthChallengeResponseSchema = z.object({
  schemaVersion: z.literal(1),
  challengeId: z.string().regex(/^ch_[A-Za-z0-9_-]{28}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  audience: D26AudienceSchema,
  signatureNamespace: z.literal("wagglebot-auth@wagglebot.dev"),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const AuthSessionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  challengeId: z.string().regex(/^ch_[A-Za-z0-9_-]{28}$/),
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  signature: z.string().min(80).max(16_384),
}).strict();

export const AuthSessionResponseSchema = z.object({
  schemaVersion: z.literal(1),
  accessToken: z.string().min(100),
  tokenType: z.literal("Bearer"),
  expiresAt: z.string().datetime({ offset: true }),
  principal: z.object({ username: z.string(), keyFingerprint: z.string() }).strict(),
}).strict();

export const D26SessionClaimsSchema = z.object({
  iss: z.string().url(),
  sub: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  aud: D26AudienceSchema,
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().regex(/^jti_[A-Za-z0-9_-]{28}$/),
}).strict().superRefine((claims, ctx) => {
  if (claims.exp <= claims.iat || claims.exp - claims.iat > 900) {
    ctx.addIssue({ code: "custom", message: "session lifetime is invalid" });
  }
});

export const AuthErrorCodeSchema = z.enum([
  "auth_required", "auth_invalid", "auth_expired", "auth_forbidden",
  "auth_rate_limited", "auth_unavailable",
]);
```

Add `AuthChallengeRecord`, `D26SessionClaims`, `D26Principal`, and
`D26SessionToken` types. Export every schema/type from the package index.

Run: `bun test packages/contracts/src/auth.test.ts && bun run typecheck`

- [ ] **Step 3: Commit the contract boundary**

```bash
git add packages/contracts/src/auth.ts packages/contracts/src/auth.test.ts packages/contracts/src/index.ts
git commit -m "feat(auth): define D26 challenge and session contracts"
```

---

## Task 2: Implement canonical challenge bytes and SSH signing client

**Files:**

- Create: `packages/d26-auth/package.json`
- Create: `packages/d26-auth/src/canonical-challenge.ts`
- Create: `packages/d26-auth/src/canonical-challenge.test.ts`
- Create: `packages/d26-auth/src/ssh-signer.ts`
- Create: `packages/d26-auth/src/ssh-signer.test.ts`
- Create: `packages/d26-auth/src/index.ts`

**Interfaces:**

- Consumes: `AuthChallengeResponse` from `@wagglebot/contracts`.
- Produces: `canonicalChallengeBytes(challenge): Uint8Array` and
  `SshSigner.sign(payload, signal): Promise<string>`.

- [ ] **Step 1: Test canonicalization and namespace binding**

```typescript
test("canonical challenge bytes are deterministic and newline-delimited", () => {
  const bytes = canonicalChallengeBytes({
    challengeId: "ch_0123456789abcdef0123456789",
    nonce: "A".repeat(43),
    username: "alice",
    audience: "wagglebot-memory",
    expiresAt: "2026-09-12T12:01:00.000Z",
  });
  expect(new TextDecoder().decode(bytes)).toBe(
    "wagglebot-auth-v1\\nch_0123456789abcdef0123456789\\n" +
    "" + "A".repeat(43) + "\\nalice\\nwagglebot-memory\\n2026-09-12T12:01:00.000Z\\n",
  );
});

test("changing audience changes the signed bytes", () => {
  expect(canonicalChallengeBytes(challenge("wagglebot-memory")))
    .not.toEqual(canonicalChallengeBytes(challenge("wagglebot-registry")));
});
```

Test that usernames, IDs, nonce, expiry, and audience cannot contain newline or
control characters. Test that the namespace constant is exactly
`wagglebot-auth@wagglebot.dev` and is not caller-configurable.

The design documents call this value a “nonce.” The nonce remains the random
challenge that proves freshness; the versioned envelope signs it together with
the challenge id, catalog username, intended audience, and expiry so a valid
signature cannot be replayed against another shared service. Every D26 client
and issuer must use this one canonical byte format.

Run: `bun test packages/d26-auth/src/canonical-challenge.test.ts`

- [ ] **Step 2: Implement the signer with explicit process arguments**

Define:

```typescript
export interface SshSigner {
  sign(payload: Uint8Array, signal: AbortSignal): Promise<string>;
}

export class SshAgentSigner implements SshSigner {
  constructor(options: {
    publicKeyPath: string;
    sshKeygenPath?: string;
    timeoutMs?: number;
  }) {}
  sign(payload: Uint8Array, signal: AbortSignal): Promise<string>;
}
```

The implementation writes the payload to a `0600` temporary file, invokes
`ssh-keygen` without a shell using the exact argument vector
`-Y sign -f <publicKeyPath> -n wagglebot-auth@wagglebot.dev -U <payloadFile>`,
reads the generated `.sig` file, deletes both files, and returns the ASCII
OpenSSH signature. Set a 5-second timeout and terminate the child on abort.
Never include the payload, key path, or stderr in an error message. The
production client requires `SSH_AUTH_SOCK`; an explicit private-key fallback
is not part of D26 v1, because silently reading a private key would weaken the
workstation boundary.

Use `Bun.spawn` with an argument array and `stdin: "ignore"`; never construct a
shell command. Reject symlinked public-key paths outside the configured home
or workspace, and reject a missing agent before spawning.

Create `packages/d26-auth/package.json` with exact workspace dependencies:

```json
{
  "name": "@wagglebot/d26-auth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "dependencies": {
    "@wagglebot/contracts": "workspace:*",
    "jose": "6.2.12"
  }
}
```

Run: `bun test packages/d26-auth/src/canonical-challenge.test.ts packages/d26-auth/src/ssh-signer.test.ts && bun run typecheck`

- [ ] **Step 3: Commit the signer seam**

```bash
git add packages/d26-auth
git commit -m "feat(auth): sign D26 challenges through ssh-agent"
```

---

## Task 3: Build the workstation session-token client and verifier

**Files:**

- Create: `packages/d26-auth/src/session-token.ts`
- Create: `packages/d26-auth/src/session-token.test.ts`
- Create: `packages/d26-auth/src/client.ts`
- Create: `packages/d26-auth/src/client.test.ts`
- Modify: `packages/d26-auth/src/index.ts`

**Interfaces:**

- Consumes: auth HTTP endpoints, `SshSigner`, `Auth*Schema`, and issuer public
  key configuration.
- Produces: `D26Client.get(audience, signal)`,
  `CachedSessionTokenProvider.get(audience, signal)`,
  `.invalidate(audience)`, and `verifyD26SessionToken(token, options)`.

- [ ] **Step 1: Write token-cache and verifier tests**

Test:

- one token request is reused until 60 seconds before expiry;
- audiences have independent cache entries;
- a 401 invalidates and retries exactly once;
- 403, timeout, malformed response, and 429 do not retry as authentication;
- issuer, audience, algorithm, signature, `sub`, `iat`, `exp`, and `jti` are
  all required;
- a token for `wagglebot-memory` is rejected by a registry verifier;
- expired and not-yet-valid tokens fail closed;
- no bearer token appears in errors, logs, or thrown provider messages.

Run: `bun test packages/d26-auth/src/session-token.test.ts packages/d26-auth/src/client.test.ts`

- [ ] **Step 2: Implement the client and cache**

Define:

```typescript
export interface SessionTokenProvider {
  get(audience: D26Audience, signal: AbortSignal): Promise<{ token: string; expiresAt: string }>;
  invalidate(audience: D26Audience): void;
}

export class D26Client implements SessionTokenProvider {
  constructor(options: {
    baseUrl: string;
    username: string;
    signer: SshSigner;
    fetch?: typeof fetch;
    clock?: () => Date;
  }) {}
  get(audience: D26Audience, signal: AbortSignal): Promise<{ token: string; expiresAt: string }>;
  invalidate(audience: D26Audience): void;
}
```

Resolve `username` once from the existing validated `wagglebot.username` local
configuration (the same company-catalog validation used by provisioning); do
not let an MCP tool or arbitrary task text choose it at runtime. The auth
service still treats the submitted value as untrusted lookup input and binds
the final principal to the verified catalog key.

`get` posts `{ schemaVersion: 1, username, audience }` to
`POST /v1/auth/challenge`, signs the canonical challenge bytes, posts
`{ schemaVersion: 1, challengeId, username, signature }` to
`POST /v1/auth/session`, validates the response, and stores one cache entry per
audience. Send no bearer header during the challenge exchange. Use HTTPS
unless the URL is loopback in an explicitly enabled development test.

Implement `CachedSessionTokenProvider` as a small wrapper if the client is
configured with a lower-level issuer client; do not duplicate cache logic in
the context engine. Refresh when `expiresAt - now <= 60_000` and use one
single-flight promise per audience so concurrent callers do not create
parallel challenges.

`verifyD26SessionToken` uses `jose.jwtVerify` with `algorithms: ["EdDSA"]`,
the configured issuer, exact audience, a 30-second clock tolerance, and the
issuer public key. Parse the claims with `D26SessionClaimsSchema` and return:

```typescript
export type VerifiedD26Principal = {
  username: string;
  audience: D26Audience;
  issuedAt: Date;
  expiresAt: Date;
  tokenId: string;
};
```

Run: `bun test packages/d26-auth/src/session-token.test.ts packages/d26-auth/src/client.test.ts && bun run check && bun run typecheck`

- [ ] **Step 3: Commit the client and verifier**

```bash
git add packages/d26-auth
git commit -m "feat(auth): add D26 workstation client and token verifier"
```

---

## Task 4: Add catalog public-key resolution

**Files:**

- Create: `services/auth/src/catalog-keys.ts`
- Create: `services/auth/src/catalog-keys.test.ts`

**Interfaces:**

- Consumes: validated Backstage catalog YAML and injected `fetch` for the
  optional GitHub source.
- Produces: `PublicKeyResolver.resolve(username): Promise<ResolvedPublicKey>`.

- [ ] **Step 1: Write resolver tests**

Test:

- catalog `User.metadata.name` must be lowercase and unique;
- `wagglebot.dev/ssh-key` is accepted only as a valid OpenSSH public key;
- the resolver returns the key and a stable SHA-256 fingerprint, never the
  private key or full key text in logs;
- missing user/key returns a generic authentication failure;
- catalog edits replace the cached key after refresh;
- GitHub source requests only `https://<pinned-host>/<username>.keys`, uses a
  2-second timeout, rejects redirects to another origin, validates every line,
  and caches a successful result for 15 minutes;
- malformed keys and GitHub responses are rejected without fallback to an
  untrusted request-provided key.

Run: `bun test services/auth/src/catalog-keys.test.ts`

- [ ] **Step 2: Implement the resolver**

Define:

```typescript
export type ResolvedPublicKey = {
  username: string;
  authorizedKey: string;
  fingerprint: string;
  source: "catalog" | "github";
};

export interface PublicKeyResolver {
  resolve(username: string, signal: AbortSignal): Promise<ResolvedPublicKey>;
  refresh(signal: AbortSignal): Promise<void>;
  ready(): boolean;
}
```

Parse catalog YAML with the existing YAML dependency and reject duplicate User
entities, unknown key annotations, and non-SSH key types. For catalog keys,
retain only the normalized `<key-type> <base64-key>` fields in memory; discard
comments and trailing fields before constructing the allowed-signers line. For
the optional GitHub
mode, construct the URL from configured host plus the validated username; do
not accept a URL or host from the HTTP request. Use `ssh-keygen -lf -` in a
bounded subprocess to validate and fingerprint keys, or the existing injected
key parser if the workspace already provides one.

Refresh the catalog before readiness, then on a configured interval. A failed
refresh keeps the last valid key set but marks readiness degraded; an initial
failure prevents `/readyz` from reporting ready.

- [ ] **Step 3: Commit key resolution**

```bash
git add services/auth/src/catalog-keys.ts services/auth/src/catalog-keys.test.ts
git commit -m "feat(auth): resolve engineer keys from the catalog"
```

---

## Task 5: Implement one-use challenge storage and SSHSIG verification

**Files:**

- Create: `services/auth/src/challenge-store.ts`
- Create: `services/auth/src/challenge-store.test.ts`
- Create: `services/auth/src/ssh-verifier.ts`
- Create: `services/auth/src/ssh-verifier.test.ts`

**Interfaces:**

- Consumes: canonical challenge bytes, `PublicKeyResolver`, and OpenSSH.
- Produces: `ChallengeStore.issue`, `.consumeAttempt`, `.consumeSuccess`,
  and `SshSignatureVerifier.verify`.

- [ ] **Step 1: Test replay and verification boundaries**

Test:

- issued challenges contain random IDs/nonces and expire after 60 seconds;
- the nonce is stored hashed, not in the challenge record or logs;
- a valid signature succeeds once;
- a second use, altered audience, altered username, altered nonce, expired
  challenge, wrong key, wrong namespace, and malformed SSHSIG fail;
- attempts increment on invalid signatures and the fourth attempt is rejected;
- successful consumption deletes the challenge immediately;
- concurrent consumes allow at most one success;
- cleanup removes expired records without touching live challenges.

Run: `bun test services/auth/src/challenge-store.test.ts services/auth/src/ssh-verifier.test.ts`

- [ ] **Step 2: Implement the in-process store**

Use a `Map<challengeId, StoredChallenge>` protected by a small promise/mutex
queue. Store:

```typescript
type StoredChallenge = {
  challengeId: string;
  nonceHash: string;
  username: string;
  audience: D26Audience;
  expiresAtMs: number;
  attempts: number;
};
```

Issue a random 32-byte nonce and 21-byte ID, hash the nonce with SHA-256, and
return only the base64url nonce in the response. On session exchange, atomically
load-and-increment the attempt, reject expired/maxed records, and delete the
record on a successful signature. Keep challenge cleanup bounded to 1,000
records per operation so an attacker cannot force an unbounded sweep.

- [ ] **Step 3: Implement the `ssh-keygen -Y verify` adapter**

Define:

```typescript
export interface SshSignatureVerifier {
  verify(input: {
    payload: Uint8Array;
    signature: string;
    username: string;
    authorizedKey: string;
    signal: AbortSignal;
  }): Promise<boolean>;
}
```

Write a `0600` temporary allowed-signers file containing exactly
`<username> <authorizedKey>`, a `0600` signature file, and the payload file.
Invoke without a shell:

```text
ssh-keygen -Y verify \
  -f <allowed-signers-file> \
  -I <username> \
  -n wagglebot-auth@wagglebot.dev \
  -s <signature-file>
```

Feed the canonical payload on stdin, set a 5-second timeout, delete every temp
file in success and failure paths, and map all non-zero exit codes to `false`
without returning stderr. Require an exact username/key match from the
resolver. The verifier must not accept a raw PKCS#1/Ed25519 signature or a
different namespace.

Run: `bun test services/auth/src/challenge-store.test.ts services/auth/src/ssh-verifier.test.ts && bun run typecheck`

- [ ] **Step 4: Commit challenge verification**

```bash
git add services/auth/src/challenge-store* services/auth/src/ssh-verifier*
git commit -m "feat(auth): enforce one-use SSH challenge verification"
```

---

## Task 6: Issue and verify audience-bound session tokens

**Files:**

- Create: `services/auth/src/config.ts`
- Create: `services/auth/src/config.test.ts`
- Create: `services/auth/src/issuer.ts`
- Create: `services/auth/src/issuer.test.ts`

**Interfaces:**

- Consumes: challenge store, key resolver, SSH verifier, `jose`, and signing
  private key configuration.
- Produces: `AuthIssuer.issueChallenge` and `AuthIssuer.exchangeSignature`.

- [ ] **Step 1: Write issuer tests**

Test:

- missing signing key, issuer URL, catalog, or allowed audience fails startup;
- challenge for an unknown audience fails before state creation;
- valid exchange returns a token whose `sub`, `aud`, `iss`, `iat`, `exp`, and
  `jti` are correct;
- token lifetime is exactly 900 seconds from the injected clock;
- the same challenge cannot issue two tokens;
- an invalid signature never reveals whether the username exists;
- catalog key replacement affects the next challenge;
- token verification rejects wrong issuer/audience/algorithm/expiry.

Run: `bun test services/auth/src/config.test.ts services/auth/src/issuer.test.ts`

- [ ] **Step 2: Implement strict configuration and issuer**

Use `loadAuthConfig(env = process.env)` with these exact fields:

```typescript
type AuthConfig = {
  bindHost: string;
  port: number;
  issuer: string;
  signingPrivateKeyFile: string;
  catalogPath: string;
  keySource: "catalog" | "github";
  githubKeysHost?: string;
  challengeTtlSeconds: 60;
  sessionTtlSeconds: 900;
  clockSkewSeconds: 30;
  maxAttemptsPerChallenge: 3;
  rateLimitWindowSeconds: 60;
  maxChallengesPerWindow: 10;
};
```

Import the Ed25519 private key with `jose.importPKCS8`, generate a unique
`jti`, and sign with `{ alg: "EdDSA", typ: "JWT" }`. The issuer must be a
configured HTTPS URL in production. Return the token only after successful
signature verification and atomic challenge consumption. Use a bounded
username/audience rate limiter: ten challenge attempts per username per
60-second window, with `429 auth_rate_limited`; do not log the username when
the limit triggers.

- [ ] **Step 3: Commit the issuer core**

```bash
git add services/auth/src/config* services/auth/src/issuer*
git commit -m "feat(auth): issue audience-bound D26 session tokens"
```

---

## Task 7: Expose the auth HTTP service

**Files:**

- Create: `services/auth/package.json`
- Create: `services/auth/Dockerfile`
- Create: `services/auth/src/http.ts`
- Create: `services/auth/src/http.test.ts`
- Create: `services/auth/src/index.ts`

**Interfaces:**

- Consumes: `AuthIssuer`, `Auth*Schema`, config, and the standard service
  health convention.
- Produces: `POST /v1/auth/challenge`, `POST /v1/auth/session`, `GET /livez`,
  and `GET /readyz`.

- [ ] **Step 1: Write HTTP contract tests**

Test exact status/body behavior:

- valid challenge is `200` with `AuthChallengeResponseSchema`;
- invalid JSON/unknown keys/unknown audience is `400 auth_invalid`;
- valid session is `200` with `AuthSessionResponseSchema`;
- missing, malformed, expired, replayed, or invalid signature is `401
  auth_invalid` with one generic body;
- rate limiting is `429 auth_rate_limited`;
- `/livez` is `200` without auth using the common versioned health body;
- `/readyz` is `200` only when catalog and signing key are ready, otherwise
  `503` with the common versioned degraded health body;
- methods and paths outside the contract return `404` without stack traces;
- request bodies, signatures, tokens, and catalog values are absent from
  captured logs.

Run: `bun test services/auth/src/http.test.ts`

- [ ] **Step 2: Implement the server**

Create `createApp(deps)` and `createServer(config)` following the existing
service convention. Parse JSON with a strict byte limit of 32 KiB. Return the
versioned error envelope with a correlation ID, stable error code, safe
message, and `retryable`; return no server details. Set `Cache-Control:
no-store` on auth responses. Do not add a bearer
requirement to the two challenge endpoints; they are the credential exchange.
All future protected routes must use `verifyD26SessionToken` and exact audience
checks.

Create `services/auth/package.json` with exact dependencies:

```json
{
  "name": "@wagglebot/auth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "bun src/index.ts", "test": "bun test" },
  "dependencies": {
    "@wagglebot/contracts": "workspace:*",
    "@wagglebot/d26-auth": "workspace:*",
    "jose": "6.2.12",
    "yaml": "2.8.3",
    "zod": "4.6.1"
  }
}
```

Build a minimal image that contains the pinned Bun runtime and OpenSSH client
needed by `ssh-keygen -Y verify`. Run as a non-root user, mount catalog and
signing key files read-only, and do not mount any engineer private-key path.

Run: `bun test services/auth/src/http.test.ts && bun run check && bun run typecheck`

- [ ] **Step 3: Commit the HTTP service**

```bash
git add services/auth
git commit -m "feat(auth): expose the D26 authentication service"
```

---

## Task 8: Integrate consumers and prove the complete flow

**Files:**

- Create: `services/auth/integration/auth-e2e.test.ts`
- Modify: `services/memory-worker/src/principal.ts`
- Modify: `services/memory-worker/src/principal.test.ts`
- Modify: `services/context-engine/src/shared/session-token.ts`
- Modify: `services/context-engine/src/shared/session-token.test.ts`
- Modify: `deploy/docker-compose.memory.yml`
- Modify: `deploy/README.md`
- Modify: `docs/api-reference.md`

- [ ] **Step 1: Add the end-to-end SSH test**

Generate a temporary Ed25519 keypair and a temporary catalog User entity. Use
the real `ssh-keygen -Y sign` and `ssh-keygen -Y verify` adapters in an isolated
temporary directory. Test both direct signing and an isolated `ssh-agent` with
`-U`; fail with a clear environment error if OpenSSH is unavailable rather
than silently skipping the security test.

Prove:

1. A registered user obtains a memory-audience token.
2. The token verifies and yields the catalog username.
3. The same token is rejected for the registry audience.
4. A changed challenge, audience, namespace, key, or username fails.
5. Replay and expiry fail.
6. A changed catalog key rejects a new signature; an existing token remains
   valid only until its 15-minute expiry.
7. The client refreshes once before expiry and deduplicates concurrent calls.
8. The memory worker accepts only the verified principal and still derives
   groups/scopes from the current catalog.
9. Captured logs contain no signature, nonce, JWT, private-key path, or key text.

Run: `bun test services/auth/integration/auth-e2e.test.ts`

- [ ] **Step 2: Integrate the memory worker and context engine**

Replace the memory worker's planned placeholder JWT verification with
`verifyD26SessionToken` from `@wagglebot/d26-auth`. Keep its existing
`sessionPublicKeyFile`, issuer, audience, and algorithm allow-list config, but
validate the claims through the shared package. The worker must still map
`sub` to the current catalog User and reject caller-supplied principal fields.

Replace the unified context plan's local placeholder `SessionTokenProvider`
implementation with the package's `D26Client`/cache. The context engine sends
only the configured audience-specific bearer token to the shared memory client.

Run: `bun test services/memory-worker/src/principal.test.ts services/context-engine/src/shared/session-token.test.ts && bun run typecheck`

- [ ] **Step 3: Add deployment and API documentation**

Add an `auth` service to the shared compose profile with:

- `D26_AUTH_HOST`, `D26_AUTH_PORT`;
- `D26_AUTH_ISSUER`;
- `D26_AUTH_SIGNING_PRIVATE_KEY_FILE`;
- `D26_AUTH_CATALOG_PATH`;
- `D26_AUTH_KEY_SOURCE` and optional pinned GitHub key host;
- read-only mounts for the catalog and signing key;
- `/livez` and `/readyz` health checks;
- no engineer private-key mount and no upstream credentials.

Document bootstrap and rotation: generate the issuer Ed25519 keypair once,
store the private key in the deployment secret manager, distribute only the
public verification key to memory/registry/coordination services, rotate the
issuer key with a coordinated restart, and rotate a user's SSH key by a
catalog pull request. Existing session tokens remain valid only until expiry.

Add to `docs/api-reference.md` the versioned auth schemas, endpoint behavior,
stable errors, 32 KiB request cap, 60-second challenge TTL, 900-second token
TTL, 10-per-minute challenge rate limit, three-attempt cap, idempotency/replay
rules, persisted/in-memory challenge record shape, and the catalog key refresh
semantics. Do not describe private keys as persisted records; they never enter
the service.

Run: `bun run check && bun run typecheck && bun test && bun run build && git diff --check`

- [ ] **Step 4: Commit the integration proof**

```bash
git add services/auth/integration services/memory-worker/src/principal* services/context-engine/src/shared/session-token* deploy/docker-compose.memory.yml deploy/README.md docs/api-reference.md
git commit -m "feat(auth): integrate D26 with shared services"
```

---

## Completion Checklist

- [ ] Phase 1 and local-only Context Bridge remain free of D26 dependencies.
- [ ] Contract schemas are strict, versioned, and exported from
      `@wagglebot/contracts`.
- [ ] The client signs only canonical bytes with the fixed SSHSIG namespace.
- [ ] The private key never leaves the workstation and no private-key path is
      mounted into the auth container.
- [ ] Challenges are random, hashed at rest, one-use, 60-second, and limited to
      three attempts.
- [ ] SSH keys resolve from the catalog by default; the optional GitHub source
      is HTTPS-only, pinned, validated, and cached.
- [ ] JWTs are EdDSA, audience-bound, issuer-bound, 15-minute, and verified with
      an explicit algorithm allow-list.
- [ ] Token caches are per audience, refresh one minute before expiry, and
      deduplicate concurrent exchanges.
- [ ] Auth failures are fail-closed, generic, rate-limited, and redacted.
- [ ] Memory and context-engine consumers derive identity from verified `sub`
      and never trust request principal/group/scope fields.
- [ ] End-to-end tests prove valid sign-in, audience isolation, replay/expiry,
      key rotation, token refresh, and no secret logging.
- [ ] Deployment and `docs/api-reference.md` document the exact D26 contract.
- [ ] `bun run check`, `bun run typecheck`, `bun test`, `bun run build`, and
      `git diff --check` pass.
