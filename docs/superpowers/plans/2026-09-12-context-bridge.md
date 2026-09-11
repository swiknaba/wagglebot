# Context Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (or `superpowers:subagent-driven-development` when the work is split into independent tasks) to execute this plan. Keep the TDD and verification checkpoints below.

**Goal:** Add a local-only, explicit Context Bridge so a user can export a small, approved packet from one chat and import it into another chat on the same workstation, without storing a transcript, creating durable memory, or silently sharing context.

**Architecture:** Add strict wire contracts to `packages/contracts`, packet normalization and an expiring mode-protected vault to `packages/local-brain`, a four-operation lifecycle facade, and four MCP tools in the existing `services/context-engine`. The default scope binds a packet to the canonical Git root; an explicit `workstation` scope permits another local repository for the same OS user. Wake remains automatic project orientation and never discovers or imports bridge packets.

**Tech Stack:** TypeScript, Bun, Zod 4, existing `@wagglebot/contracts`, `@wagglebot/local-brain`, `@wagglebot/secret-scanner`, `@wagglebot/context-engine`, Node/Bun `crypto`, `fs/promises`, `path`, and `os`, Bun tests, Biome, and the existing project-identity/path-policy utilities. No new runtime dependency is required.

**Spec:** `docs/superpowers/specs/2026-09-12-context-bridge-design.md`

## Global Constraints

- Execute this plan only after the Local Repository Brain and Unified Context Engine milestones have established `packages/contracts`, `packages/local-brain`, the project identity/path policy, `EvidenceRef`, the shared secret scanner, and the local MCP server.
- Keep the implementation local-only: no network client, no shared-memory worker call, no D26 token, no CodeGraph write, no Git mutation, and no telemetry containing packet data.
- Export and import are always explicit MCP calls. Wake must not search the vault, infer a handle, or import a packet automatically.
- Accept only the packet fields defined below. Never accept or persist a transcript, prompt, hidden reasoning, session object, session-file path, source excerpt, diff, credential, arbitrary metadata, or free-form replacement payload.
- Default to `project` scope. `workstation` scope must be selected during export and cannot be added or overridden at import time.
- Resolve `projectPath` through the existing absolute-path and repository-root policy. Store only the non-reversible `rootKey` plus repository-relative project metadata.
- Use a cryptographically random opaque handle; store `sha256(handle)` as the filename so the handle is not visible in directory listings. Never log the handle or packet content.
- Create the vault directory as mode `0700` and packet files as mode `0600`. Verify owner and permissions before reading or writing; fail closed on unsafe permissions.
- Use a one-hour default TTL, a four-hour maximum TTL, a maximum of eight successful imports per packet, at most 32 live packets, at most 512 KiB total stored packet bytes, and the 16 KiB serialized-packet limit from the design.
- Run the shared secret scanner before any packet is written. Reject secret matches, NUL/control characters, absolute paths, transcript-shaped fields, and unknown fields without echoing the offending value.
- Expired packets are removed during startup and before every operation. A full vault removes expired packets but never evicts a live packet.
- Import returns an explicitly labeled imported packet and never calls memory promotion. Any later `brain_memory_save`, `remember`, or `forget` action remains a separate user-authorized operation.
- Follow the unified engine single-representation rule: structured mode carries packet prose once; Markdown mode is opt-in and carries the prose in the text preview while structured content contains metadata only.
- Treat the v1 tool schemas, lifecycle/idempotency semantics, stable errors,
  and size limits in `docs/api-reference.md` as authoritative. The local bridge
  has no application requests-per-minute limit.
- Run `bun run check && bun run typecheck && bun test` at every phase gate. Do not claim completion when any relevant check is skipped or failing.

## Repository Map

Create or modify only these files during this feature:

```text
packages/contracts/src/context-bridge.ts
packages/contracts/src/context-bridge.test.ts
packages/contracts/src/index.ts

packages/local-brain/src/context/root-key.ts
packages/local-brain/src/context/root-key.test.ts
packages/local-brain/src/context/packet.ts
packages/local-brain/src/context/packet.test.ts
packages/local-brain/src/context/vault.ts
packages/local-brain/src/context/vault.test.ts
packages/local-brain/src/context/bridge.ts
packages/local-brain/src/context/bridge.test.ts
packages/local-brain/src/index.ts

services/context-engine/src/mcp/context-bridge.ts
services/context-engine/src/mcp/context-bridge.test.ts
services/context-engine/src/mcp/server.ts
services/context-engine/src/index.ts
services/context-engine/integration/context-bridge-e2e.test.ts

packages/cli/templates/AGENTS.base.md
docs/project-brain.md
```

The package manifests are modified only if the workspace packages do not yet
export the dependencies listed above. Do not add a second filesystem, schema,
secret-scanning, or project-identity implementation.

---

## Task 1: Add strict Context Bridge contracts

**Files:**

- Create: `packages/contracts/src/context-bridge.ts`
- Create: `packages/contracts/src/context-bridge.test.ts`
- Modify: `packages/contracts/src/index.ts`

### Step 1: Write failing contract tests

Add tests that prove valid packets parse and unsafe shapes fail:

```ts
import { describe, expect, test } from "bun:test";
import {
  ContextBridgeExportInputSchema,
  ContextBridgePacketSchema,
  ContextBridgeToolErrorSchema,
} from "./context-bridge";

test("accepts the smallest valid project packet", () => {
  const result = ContextBridgePacketSchema.safeParse({
    schemaVersion: 1,
    packetId: "cb_pkt_01JTEST000000000000000000",
    project: { rootKey: "rk_0123456789abcdef0123456789abcdef" },
    scope: "project",
    goal: "Ship the context bridge",
    decisions: [],
    openQuestions: [],
    evidence: [],
    providerState: { localBrain: "ready", sharedMemory: "not_requested" },
    createdAt: "2026-09-12T10:00:00.000Z",
    expiresAt: "2026-09-12T11:00:00.000Z",
  });

  expect(result.success).toBe(true);
});

test.each([
  ["goal over 300 code points", { goal: "x".repeat(301) }],
  ["eleven decisions", { decisions: Array.from({ length: 11 }, () => ({ title: "t", summary: "s" })) }],
  ["absolute evidence path", { evidence: [{ kind: "file", path: "/private/file.ts", lineStart: 1, lineEnd: 1 }] }],
  ["unknown transcript field", { transcript: "do not accept" }],
])("rejects %s", (_name, override) => {
  const input = validExportInput(override);
  expect(ContextBridgeExportInputSchema.safeParse(input).success).toBe(false);
});

test("error schema is a closed enum", () => {
  expect(ContextBridgeToolErrorSchema.safeParse("context_expired").success).toBe(true);
  expect(ContextBridgeToolErrorSchema.safeParse("internal_stack").success).toBe(false);
});
```

Add a local `validExportInput` fixture in the test file. Include boundary tests
for every code-point, array-count, evidence-count, TTL, and serialized-size
limit. Use repository-relative evidence fixtures only.

Run: `bun test packages/contracts/src/context-bridge.test.ts`

Expected before implementation: the test fails because the schemas and exports
do not exist.

### Step 2: Implement the schemas and public types

Create strict Zod schemas. Reuse `EvidenceRefSchema` from `context.ts`; do not
define a second evidence format. The public contract must contain these types:

```ts
export const ContextBridgeScopeSchema = z.enum(["project", "workstation"]);
export const ContextBridgeResponseFormatSchema = z.enum(["structured", "markdown"]);
export const ContextBridgeToolErrorSchema = z.enum([
  "context_invalid",
  "context_expired",
  "context_project_mismatch",
  "context_owner_mismatch",
  "context_limit",
  "context_unavailable",
]);

export const ContextBridgePacketSchema = z.object({
  schemaVersion: z.literal(1),
  packetId: z.string().regex(/^cb_pkt_[A-Za-z0-9_-]{20,80}$/),
  project: z.object({
    rootKey: z.string().regex(/^rk_[a-f0-9]{32}$/),
    component: z.string().min(1).max(120).optional(),
    system: z.string().min(1).max(120).optional(),
    branch: z.string().min(1).max(240).optional(),
    head: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
  }).strict(),
  scope: ContextBridgeScopeSchema,
  goal: boundedUnicodeString(300),
  decisions: z.array(z.object({
    title: boundedUnicodeString(80),
    summary: boundedUnicodeString(600),
  }).strict()).max(10),
  openQuestions: z.array(boundedUnicodeString(240)).max(10),
  evidence: z.array(EvidenceRefSchema).max(20),
  providerState: z.object({
    localBrain: z.enum(["ready", "degraded", "missing"]),
    sharedMemory: z.enum(["ready", "degraded", "not_requested"]),
  }).strict(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const ContextBridgeExportInputSchema = z.object({
  projectPath: z.string().refine(isAbsolutePath),
  scope: ContextBridgeScopeSchema.default("project"),
  goal: boundedUnicodeString(300),
  decisions: ContextBridgePacketSchema.shape.decisions,
  openQuestions: ContextBridgePacketSchema.shape.openQuestions,
  evidence: ContextBridgePacketSchema.shape.evidence,
  providerState: ContextBridgePacketSchema.shape.providerState,
  ttlSeconds: z.number().int().min(1).max(14_400).optional(),
  responseFormat: ContextBridgeResponseFormatSchema.default("structured"),
}).strict();

export const ContextBridgeHandleInputSchema = z.object({
  handle: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  projectPath: z.string().refine(isAbsolutePath),
  responseFormat: ContextBridgeResponseFormatSchema.default("structured"),
}).strict();

export const ContextBridgeStatusInputSchema = z.object({
  projectPath: z.string().refine(isAbsolutePath),
}).strict();

export const ContextBridgeRevokeInputSchema = z.object({
  handle: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  projectPath: z.string().refine(isAbsolutePath),
}).strict();
```

Add output types for `ContextBridgeExportResult`, `ContextBridgeImportResult`,
`ContextBridgeStatusResult`, and `ContextBridgeRevokeResult`. Output metadata
must include `scope`, `packetId`, `createdAt`, `expiresAt`, and relative project
metadata; status must never include `goal`, decisions, questions, evidence, or
any rendered prose. Export and import return a structured packet only in
`structured` mode; in `markdown` mode the structured branch contains metadata
and the text branch contains the one requested preview.

Export all schemas and types from `packages/contracts/src/index.ts`.

Run: `bun test packages/contracts/src/context-bridge.test.ts && bun run typecheck`

### Step 3: Commit the contract boundary

```bash
git add packages/contracts/src/context-bridge.ts packages/contracts/src/context-bridge.test.ts packages/contracts/src/index.ts
git commit -m "feat(context): add context bridge contracts"
```

---

## Task 2: Normalize packets and bind them to a project

**Files:**

- Create: `packages/local-brain/src/context/root-key.ts`
- Create: `packages/local-brain/src/context/root-key.test.ts`
- Create: `packages/local-brain/src/context/packet.ts`
- Create: `packages/local-brain/src/context/packet.test.ts`

### Step 1: Test root-key and packet normalization behavior

Cover these observable rules:

- canonical paths for the same Git root produce the same root key;
- different roots produce different keys;
- the root key is the 32-hex-character digest prefixed by `rk_` and does not
  reveal the absolute path;
- packet IDs are random and do not contain project paths or packet prose;
- timestamps are UTC ISO strings and `expiresAt` is within the configured TTL;
- input order is preserved for decisions, open questions, and evidence;
- line endings are normalized to `\n` before scanning and serialization;
- secret-like text, NUL/control characters, absolute paths, transcript fields,
  and unknown fields are rejected;
- the serialized packet is at most 16 KiB;
- a scanner failure maps to `context_unavailable` and does not create a file.

Use a fake scanner with a call recorder and an injected clock. Assert the
scanner receives the complete serialized packet before persistence and that
test output never includes the matched secret value.

Run: `bun test packages/local-brain/src/context/root-key.test.ts packages/local-brain/src/context/packet.test.ts`

### Step 2: Implement deterministic root-key and packet helpers

Implement:

```ts
export function rootKeyForCanonicalRoot(canonicalRoot: string): string {
  return `rk_${createHash("sha256")
    .update("wagglebot:context-root:v1\\0")
    .update(canonicalRoot, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

export type PacketDependencies = {
  now: () => Date;
  packetId: () => string;
  scanner: Pick<SecretScanner, "scanText">;
};

export async function buildContextBridgePacket(
  input: ContextBridgeExportInput,
  identity: ProjectIdentity,
  deps: PacketDependencies,
): Promise<ContextBridgePacket>;
```

`buildContextBridgePacket` must use the existing identity resolver, never accept
an unverified caller-provided `rootKey`, and validate that the current root is
canonical before hashing. Set `expiresAt` from `ttlSeconds ?? 3600`, reject a
TTL above 14,400 seconds, serialize with stable key ordering, scan the exact
serialized bytes as UTF-8, and then enforce the 16 KiB byte limit. Return a
typed `context_invalid` or `context_unavailable` error without including raw
input values.

Run: `bun test packages/local-brain/src/context/root-key.test.ts packages/local-brain/src/context/packet.test.ts && bun run typecheck`

### Step 3: Commit packet validation

```bash
git add packages/local-brain/src/context/root-key* packages/local-brain/src/context/packet*
git commit -m "feat(context): validate bridge packets and project scope"
```

---

## Task 3: Build the protected expiring vault

**Files:**

- Create: `packages/local-brain/src/context/vault.ts`
- Create: `packages/local-brain/src/context/vault.test.ts`

### Step 1: Write filesystem and lifecycle tests

Use `mkdtemp` for an isolated state root and inject `now`, `randomBytes`, and
the current owner identity. Do not read or modify the developer's real home
directory. Test:

1. first export creates `<stateRoot>/context` as `0700` and a packet file as
   `0600`;
2. the filename is `sha256(handle).hex + ".json"` and does not contain the
   handle;
3. writes use a unique temporary file, `chmod(0600)`, file `sync`, and atomic
   rename; a failed write leaves no final packet;
4. restart (a new `ContextVault` instance) can import a live packet;
5. expired packets are deleted on startup and before each operation;
6. a project mismatch is reported without returning packet contents;
7. owner or mode mismatch is fail-closed;
8. corrupt JSON deletes only that packet and returns `context_unavailable`;
9. revoke is idempotent, returns `revoked: true` for any well-formed handle,
   and cannot affect another handle;
10. the ninth import returns `context_limit` while the first eight succeed;
11. a 33rd live packet or 512 KiB aggregate limit returns `context_limit` after
    expired cleanup and never evicts a live packet;
12. concurrent exports create independent handles and files.

Run: `bun test packages/local-brain/src/context/vault.test.ts`

### Step 2: Implement the vault with an opaque-handle envelope

Use standard-library filesystem primitives and an injected state-root resolver;
do not use shell commands. Define these internal shapes:

```ts
const DEFAULT_TTL_SECONDS = 3_600;
const MAX_TTL_SECONDS = 14_400;
const MAX_IMPORTS = 8;
const MAX_LIVE_PACKETS = 32;
const MAX_VAULT_BYTES = 512 * 1024;

type StoredEnvelope = {
  schemaVersion: 1;
  handleHash: string;
  ownerUid?: number;
  importCount: number;
  packet: ContextBridgePacket;
};

export type ContextVault = {
  put(packet: ContextBridgePacket): Promise<StoredPacketMeta>;
  get(handle: string, expectedRootKey: string | undefined): Promise<StoredPacket>;
  status(): Promise<ReadonlyArray<StoredPacketMeta>>;
  revoke(handle: string): Promise<boolean>;
};
```

Generate a 32-byte random handle and encode it as 43-character base64url. Keep
only `handleHash = sha256(handle).hex` in the envelope. Validate the handle
shape before deriving any path; reject traversal, slash, and malformed input.
Use `lstat`/`stat` to verify the vault directory and packet owner/mode before
reading. On Unix require no group/other permission bits; on platforms without
numeric uid, still require the mode boundary. Never silently repair unsafe
permissions.

Write via `open(temp, "wx", 0o600)`, `write`, `sync`, `chmod`, `close`, and
`rename`. Remove the temp file on every error. On revoke and expiry, unlink the
hashed filename; missing files are treated as already revoked. Directory
enumeration is metadata-only and never parses packet prose for status.

Map errors to the contract's stable codes. Do not expose `ENOENT`, absolute
paths, stack traces, matched secret values, or raw JSON through MCP.

Run: `bun test packages/local-brain/src/context/vault.test.ts && bun run typecheck`

### Step 3: Commit the vault

```bash
git add packages/local-brain/src/context/vault.ts packages/local-brain/src/context/vault.test.ts
git commit -m "feat(context): persist expiring local context packets"
```

---

## Task 4: Add the Context Bridge lifecycle facade

**Files:**

- Create: `packages/local-brain/src/context/bridge.ts`
- Create: `packages/local-brain/src/context/bridge.test.ts`
- Modify: `packages/local-brain/src/index.ts`

### Step 1: Test the public lifecycle

Build a fake project identity resolver, fake scanner, and temporary vault. Test
the public behavior rather than private file layout:

- `export` resolves the canonical Git root, builds/scans the packet, stores it,
  and returns handle plus expiry and project metadata;
- export without a usable repository fails before creating a packet;
- `import` requires the handle and absolute project path, checks project scope,
  increments the import count only after successful validation, and returns an
  imported packet labeled with `imported: true` in the result envelope (not in
  the stored packet schema);
- project-scoped import in a different root returns
  `context_project_mismatch` without revealing the packet;
- workstation-scoped import in a different root succeeds only when the export
  scope was `workstation`;
- status exposes count and metadata only;
- revoke is idempotent;
- no local-memory, shared-memory, network, CodeGraph, or Git-mutating mock is
  called by any operation;
- importing never changes the local memory file or a context cursor.

Run: `bun test packages/local-brain/src/context/bridge.test.ts`

### Step 2: Implement the facade interface

Expose one constructor and four methods:

```ts
export type ContextBridge = {
  export(input: ContextBridgeExportInput): Promise<ContextBridgeExportResult>;
  import(input: ContextBridgeHandleInput): Promise<ContextBridgeImportResult>;
  status(input: { projectPath: string }): Promise<ContextBridgeStatusResult>;
  revoke(input: { handle: string; projectPath: string }): Promise<ContextBridgeRevokeResult>;
};

export function createContextBridge(deps: {
  identity: ProjectIdentityResolver;
  scanner: SecretScanner;
  vault: ContextVault;
  now?: () => Date;
}): ContextBridge;
```

Use `resolveProjectPath` and `identifyProject` from the local-brain package.
`status` may show only packet metadata safe for the current caller and never
returns handles. This keeps status useful for health/expiry inspection without
turning it into a handle-discovery shortcut for import. Revoke remains the only
operation that accepts a handle without returning packet prose. Its public
result is always `{ revoked: true }` for a well-formed handle, whether the
packet existed, was already revoked, or expired; this keeps the operation
idempotent without becoming an existence oracle.
Filter status to project-scoped packets matching the supplied project root and
workstation-scoped packets owned by the current OS user; never expose metadata
from another owner or a different project-scoped root.

For import, compare the current root key with the stored packet's root key only
when `packet.scope === "project"`. For `workstation`, still verify current OS
user and safe vault permissions. Return packet data under an explicit
`importedContext` field so downstream formatting cannot confuse it with wake or
durable memory.

### Step 3: Export the facade and run focused checks

Export the constructor and public types from `packages/local-brain/src/index.ts`.

Run: `bun test packages/local-brain/src/context && bun run check && bun run typecheck`

### Step 4: Commit the lifecycle facade

```bash
git add packages/local-brain/src/context/bridge.ts packages/local-brain/src/context/bridge.test.ts packages/local-brain/src/index.ts
git commit -m "feat(context): add bridge lifecycle facade"
```

---

## Task 5: Expose the four MCP tools

**Files:**

- Create: `services/context-engine/src/mcp/context-bridge.ts`
- Create: `services/context-engine/src/mcp/context-bridge.test.ts`
- Modify: `services/context-engine/src/mcp/server.ts`
- Modify: `services/context-engine/src/index.ts`

### Step 1: Write MCP adapter tests

Register exactly these tools in addition to the existing local/context tools:

- `brain_context_export`
- `brain_context_import`
- `brain_context_status`
- `brain_context_revoke`

Test with a fake `ContextBridge`:

- schemas reject relative `projectPath`, unknown keys, transcript/prompt/
  reasoning/session-file fields, free-form replacement text, invalid handles,
  and TTLs above four hours;
- export defaults to project scope and structured response;
- workstation scope must be present in the export request, never import;
- structured export/import returns packet prose exactly once in structured data;
- Markdown response is only produced when `responseFormat: "markdown"` is
  explicit;
- status returns metadata only;
- errors map to stable codes and omit stacks, local paths, handles, and packet
  content from text diagnostics;
- tool registration does not call the shared-memory client or network layer.

Run: `bun test services/context-engine/src/mcp/context-bridge.test.ts`

### Step 2: Implement the adapter

Create a small adapter rather than putting vault logic in the MCP server:

```ts
export function registerContextBridgeTools(
  server: McpServer,
  bridge: ContextBridge,
): void;
```

Each tool validates with the contract schema before invoking the facade. Use
the existing server's error/result helpers and preserve its request-id and
logging rules. The adapter must return:

- structured export: `{ handle, packetMeta, packet }` plus a short non-prose
  text acknowledgement;
- structured import: `{ importedContext: packet, packetMeta }` plus a short
  acknowledgement;
- Markdown export/import: metadata in structured content and one compact
  rendered preview in text;
- status: `{ packetCount, packets: [{ packetId, scope, project, createdAt, expiresAt, importCount }] }`; it never returns handles, goals, decisions, questions, evidence, or rendered prose, so status cannot become a handle-discovery shortcut;
- revoke: `{ revoked: true }` and no packet data.

For error text, use only `code` and safe counts/rule identifiers. A project
mismatch must not reveal the packet's originating path or goal. Keep the MCP
input schema closed so adding a prompt or transcript field is a compile-time
and runtime test failure.

### Step 3: Wire the adapter into the server

Construct the facade from the existing local-brain dependency graph and call
`registerContextBridgeTools` during server setup. Do not create a second MCP
server, second vault, or second project identity resolver. Keep the tool names
stable and add them to the service's exported tool inventory.

Run: `bun test services/context-engine/src/mcp/context-bridge.test.ts services/context-engine/src/mcp && bun run typecheck`

### Step 4: Commit the MCP surface

```bash
git add services/context-engine/src/mcp/context-bridge* services/context-engine/src/mcp/server.ts services/context-engine/src/index.ts
git commit -m "feat(context): expose bridge MCP tools"
```

---

## Task 6: Add end-to-end proof and documentation

**Files:**

- Create: `services/context-engine/integration/context-bridge-e2e.test.ts`
- Modify: `packages/cli/templates/AGENTS.base.md`
- Modify: `docs/project-brain.md`

### Step 1: Add the restart, scope, and security integration test

Use two temporary Git repositories under one temporary state root and two
`ContextBridge` instances to simulate separate chat processes. Prove:

1. Chat A exports a project-scoped packet; Chat B imports it in the same repo
   with the opaque handle.
2. A new Chat B without the handle cannot import or discover the packet through
   wake/status.
3. The same handle fails in the second repo with
   `context_project_mismatch`.
4. A separately exported `workstation` packet imports in the second repo for
   the same OS user.
5. A new bridge instance can import a live packet after restart.
6. Advancing the injected clock past expiry prevents import and removes the
   packet.
7. Revoke prevents future import and is idempotent.
8. Secret-like, transcript-shaped, absolute-path, and oversized input never
   produces a persisted file.
9. The test doubles for network/shared-memory/memory-promotion are never called.
10. Captured logs contain no goal text, question text, handle, path, or secret.

Run: `bun test services/context-engine/integration/context-bridge-e2e.test.ts`

### Step 2: Document the user-visible boundary

In `docs/project-brain.md`, add a short “Wake vs Context Bridge” section with
the following rules:

- Wake is automatic, tiny project orientation regenerated for a chat.
- Context Bridge is explicit export/import by opaque handle.
- Project scope is the default; workstation scope is an explicit opt-in.
- Bridge packets expire and are not durable memory or transcripts.
- Imported context is labeled and must be promoted through existing explicit
  memory tools if it should become durable.

In `packages/cli/templates/AGENTS.base.md`, add concise operational guidance:
never ask the vault for packets automatically, never put transcripts or secrets
in an export, and never treat imported context as an authoritative memory fact
without checking its evidence/freshness.

### Step 3: Run the full Phase 2 gates

Run the focused suites first:

```bash
bun test packages/contracts/src/context-bridge.test.ts
bun test packages/local-brain/src/context
bun test services/context-engine/src/mcp/context-bridge.test.ts services/context-engine/integration/context-bridge-e2e.test.ts
```

Then run the repository gates:

```bash
bun run check
bun run typecheck
bun test
bun run build
git diff --check
```

Inspect `git diff --stat` and `git status --short`; remove generated files,
temporary vaults, logs, and unrelated formatting changes before the final
review. Confirm that only the files listed in this plan changed.

### Step 4: Commit the documentation and proof

```bash
git add services/context-engine/integration/context-bridge-e2e.test.ts packages/cli/templates/AGENTS.base.md docs/project-brain.md
git commit -m "docs(context): document wake and bridge separation"
```

---

## Completion Checklist

- [ ] Strict contracts reject unknown, transcript-shaped, path-unsafe,
      secret-like, oversized, and invalid-scope inputs.
- [ ] Export creates only a bounded packet with a random opaque handle; the
      handle is not present in the filename or logs.
- [ ] The vault has mode `0700` directory and mode `0600` files, verifies owner,
      uses atomic writes, survives restart within TTL, and fails closed on
      unsafe permissions.
- [ ] Default project scope blocks cross-repository import; explicit
      workstation scope permits same-user cross-repository import.
- [ ] Expiry, revocation, corrupt packets, import cap, live-count cap, and
      aggregate-size cap behave exactly as specified.
- [ ] Four MCP tools are registered with closed schemas and stable errors.
- [ ] Structured and Markdown responses obey single-representation rules.
- [ ] Import does not mutate local/shared memory, CodeGraph, Git, cursors, or
      task state.
- [ ] Wake does not discover or import bridge packets.
- [ ] Integration tests prove same-repository continuation, explicit
      workstation sharing, restart persistence, expiry, revocation, and no
      network/shared-worker usage.
- [ ] `bun run check`, `bun run typecheck`, `bun test`, `bun run build`, and
      `git diff --check` pass, and the final diff contains no unrelated files.
