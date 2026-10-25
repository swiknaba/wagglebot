import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuthClient, SshAgentSigner } from "@wagglebot/auth-protocol";
import { ContextPacketSchema, RegistrySnapshotSchema } from "@wagglebot/contracts";
import { createLocalBrain } from "@wagglebot/local-brain";
import { sourceKey } from "../../../packages/knowledge/src/keys";
import { loadHubConfig } from "../../mcp-hub/src/config";
import { createHubRuntime } from "../../mcp-hub/src/index";
import { TrustStore } from "../../mcp-hub/src/trust";

let stage = "configuration";
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

function packetFrom(result: CallToolResult) {
  assert(!result.isError, "context execution rejected");
  return ContextPacketSchema.parse(result.structuredContent);
}

async function callContextTool(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = await client.callTool({ name, arguments: args });
  assert("content" in result && Array.isArray(result.content), "context tool did not return a completed result");
  return result as CallToolResult;
}

function assertSingleProseRepresentation(result: CallToolResult, prose: string): void {
  assert(prose.length > 0);
  assert.equal(JSON.stringify(result).split(prose).length - 1, 1);
}

function codeGraphDirectoryName(): string {
  const configured = process.env.CODEGRAPH_DIR?.trim();
  if (
    !configured ||
    configured === "." ||
    configured.includes("..") ||
    configured.includes("/") ||
    configured.includes("\\") ||
    isAbsolute(configured)
  )
    return ".codegraph";
  return configured;
}

function ignoreLocalCodeGraphIndex(projectRoot: string): void {
  const excludePath = join(projectRoot, ".git", "info", "exclude");
  const existing = readFileSync(excludePath, "utf8");
  const rule = `/${codeGraphDirectoryName()}/`;
  if (!existing.split(/\r?\n/u).includes(rule))
    writeFileSync(excludePath, `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${rule}\n`);
}

export async function smokePhase2(state: string): Promise<void> {
  const fixture = JSON.parse(readFileSync(join(state, "fixture.json"), "utf8")) as {
    issuer: string;
    revision: string;
    workspace: string;
  };
  const admin = process.env.STACK_ADMIN_TOKEN;
  assert(admin, "load the generated environment file");
  const clientDirectory = join(state, "client");
  const caPath = join(state, "config", "ca.crt");
  const ca = readFileSync(caPath, "utf8");
  const capturedSharedRequests: Record<string, unknown>[] = [];
  const request = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetch(input, { ...init, redirect: "error", tls: { ca } });
  const composeCommand = Bun.which("docker-compose") ? ["docker-compose"] : ["docker", "compose"];
  const compose = (...args: string[]) =>
    execFileSync(
      composeCommand[0] as string,
      [
        ...composeCommand.slice(1),
        "--env-file",
        join(state, ".env"),
        "-f",
        join(fixture.workspace, "deploy", "compose.yaml"),
        "-p",
        "wagglebot-phase2",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
  const waitReady = async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        if ((await request(`${fixture.issuer}/readyz`, { signal: AbortSignal.timeout(3_000) })).ok) return;
      } catch {
        /* Startup and restart may briefly refuse connections. */
      }
      await pause(500);
    }
    throw new Error("readiness deadline exceeded");
  };
  const socket = join(clientDirectory, "agent.sock");
  const previousSocket = process.env.SSH_AUTH_SOCK;
  const agent = Bun.spawn(["ssh-agent", "-D", "-a", socket], { stdout: "ignore", stderr: "ignore" });
  let runtime: Awaited<ReturnType<typeof createHubRuntime>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let sharedProxy: ReturnType<typeof Bun.serve> | undefined;
  const client = new Client({ name: "phase2-compose", version: "1" });
  const localBrain = createLocalBrain();
  try {
    stage = "TLS readiness and SSH authentication";
    await waitReady();
    for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt++) await pause(25);
    process.env.SSH_AUTH_SOCK = socket;
    execFileSync("ssh-add", [join(clientDirectory, "id_ed25519")], { stdio: "ignore" });
    const tokens = new AuthClient({
      baseUrl: fixture.issuer,
      username: "alice",
      signer: new SshAgentSigner({ publicKeyPath: join(clientDirectory, "id_ed25519.pub") }),
      fetch: request,
    });
    const signal = AbortSignal.timeout(15_000);
    const memoryToken = (await tokens.get("wagglebot-memory", signal)).token;
    const registryToken = (await tokens.get("wagglebot-registry", signal)).token;
    assert.equal((await request(`${fixture.issuer}/registry`)).status, 401);
    assert.equal(
      (await request(`${fixture.issuer}/registry`, { headers: { authorization: `Bearer ${memoryToken}` } })).status,
      401,
    );
    const registryResponse = await request(`${fixture.issuer}/registry`, {
      headers: { authorization: `Bearer ${registryToken}` },
    });
    assert(registryResponse.ok);
    const registry = RegistrySnapshotSchema.parse(await registryResponse.json());
    assert.equal(registry.principal.username, "alice");
    sharedProxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: {
        cert: readFileSync(join(state, "config", "tls.crt"), "utf8"),
        key: readFileSync(join(state, "config", "tls.key"), "utf8"),
      },
      async fetch(incoming) {
        const url = new URL(incoming.url);
        const bytes = await incoming.arrayBuffer();
        if (incoming.method === "POST" && url.pathname === "/v1/memory/search") {
          try {
            capturedSharedRequests.push(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>);
          } catch {
            throw new Error("captured shared request was invalid");
          }
        }
        const headers = new Headers(incoming.headers);
        for (const header of ["connection", "content-length", "host"]) headers.delete(header);
        return request(`${fixture.issuer}${url.pathname}${url.search}`, {
          method: incoming.method,
          headers,
          ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body: bytes }),
        });
      },
    });
    const sharedMemoryUrl = `https://localhost:${sharedProxy.port}`;
    const trustPath = join(clientDirectory, "trust.json");
    const trust = new TrustStore(trustPath);
    await trust.load();
    for (const proxy of registry.proxies) await trust.approve(proxy, ["credential", "origin", "command", "package"]);
    const bearer = randomBytes(32).toString("hex");
    const env = {
      ...process.env,
      PATH: `${join(state, "bin")}:${process.env.PATH ?? ""}`,
      PHASE2_MEMORY_TOKEN: memoryToken,
      PHASE2_CLIENT_HOME: clientDirectory,
      WAGGLEBOT_COMPANY_ROOT: join(state, "config", "company"),
      MEMORY_WORKER_URL: sharedMemoryUrl,
      MCP_HUB_AUTH_URL: fixture.issuer,
      MCP_HUB_AUTH_USERNAME: "alice",
      MCP_HUB_AUTH_PUBLIC_KEY_FILE: join(clientDirectory, "id_ed25519.pub"),
      NODE_EXTRA_CA_CERTS: caPath,
      MCP_HUB_CONFIG_URL: `${fixture.issuer}/registry`,
      MCP_HUB_TRUST_PATH: trustPath,
      MCP_HUB_BEARER_TOKEN: bearer,
      MCP_HUB_STARTUP_STRICT: "1",
      MCP_HUB_TOOL_REFRESH: "0",
      MCP_HUB_TOOL_TIMEOUT_SECONDS: "30",
      CODEGRAPH_TELEMETRY: "0",
    };
    stage = "native hub and context MCP startup";
    runtime = await createHubRuntime(loadHubConfig(env), {
      env,
      tokens,
      fetch: request,
      upstreamFetch: request,
      trustStore: trust,
    });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: runtime.app.fetch });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      }),
    );
    const execute = async (tool: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      const result = await client.callTool({ name: "execute", arguments: { tool, arguments: args } });
      assert(!result.isError, "hub execution rejected");
      const inner = (result.structuredContent as { result?: CallToolResult } | undefined)?.result;
      assert(inner && !inner.isError, "upstream execution rejected");
      return inner;
    };
    const contextProcessEnv = Object.fromEntries(
      Object.entries({
        ...env,
        SSH_AUTH_SOCK: socket,
        HOME: clientDirectory,
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    const openLocalContext = async () => {
      const processClient = new Client({ name: "phase2-context-process", version: "1" });
      const transport = new StdioClientTransport({
        command: join(state, "bin", "wagglebot-context-engine"),
        args: [],
        env: contextProcessEnv,
      });
      await processClient.connect(transport);
      return { client: processClient, close: () => processClient.close() };
    };
    const authorized = (path: string, body: unknown, token = memoryToken, method = "POST") =>
      request(`${fixture.issuer}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const repositoryA = join(state, "repository-a");
    const repositoryB = join(state, "repository-b");
    const repositoryC = join(state, "repository-c");
    const beforeA = (await localBrain.memory.read(repositoryA))?.bundleHash;
    const beforeB = (await localBrain.memory.read(repositoryB))?.bundleHash;
    const beforeC = (await localBrain.memory.read(repositoryC))?.bundleHash;
    stage = "CodeGraph initialization in three component repositories";
    assert("initialize" in localBrain.code);
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = clientDirectory;
      for (const repository of [repositoryA, repositoryB, repositoryC]) {
        const database = join(repository, codeGraphDirectoryName(), "codegraph.db");
        if (existsSync(database)) {
          assert("explore" in localBrain.code);
          const graph = await localBrain.code.explore({
            projectRoot: repository,
            query: "retryWindowMinutes",
            maxNodes: 20,
            includeCode: true,
          });
          assert(graph.nodes.some((node) => node.name === "retryWindowMinutes"));
        } else {
          await localBrain.code.initialize(repository);
        }
        ignoreLocalCodeGraphIndex(repository);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    const operation = `compose-${randomUUID()}`;
    const fact = {
      schemaVersion: 1,
      operationKey: `${operation}-remember`,
      scope: { kind: "system", name: "checkout" },
      kind: "fact",
      title: "Checkout retry policy",
      content: "Checkout retries for five minutes before escalating.",
      confidence: "high",
      wake: true,
      reviewAfter: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
      provenance: [
        {
          sourceType: "human",
          actor: "alice",
          repository: "repository-a",
          path: "catalog-info.yaml",
          capturedAt: new Date().toISOString(),
        },
      ],
    };
    stage = "repository A confirmed fact write and audience isolation";
    assert.equal((await authorized("/v1/memories", fact, registryToken)).status, 401);
    const rejectedSecret = await authorized("/v1/memories", {
      ...fact,
      operationKey: `${operation}-rejected`,
      title: "Rejected credential fixture",
      content: "token:synthetic-credential-value",
    });
    assert.equal(rejectedSecret.status, 422);
    assert.equal(((await rejectedSecret.json()) as { error: { code: string } }).error.code, "secret_rejected");
    const remembered = await authorized("/v1/memories", fact);
    assert(remembered.ok);
    const original = (await remembered.json()) as { outcomes: Array<{ recordId: string }> };
    const recordId = original.outcomes[0]?.recordId;
    assert(recordId);
    const direct = await execute("shared-memory_memory_query", { id: recordId });
    assert.equal((direct.structuredContent as { record: { id: string } }).record.id, recordId);

    stage = "CodeGraph persistence, Git decision history, explanation, and pending marker";
    const history = (
      (await execute("project-brain_git_history", { projectPath: repositoryA, limit: 10 })).structuredContent as {
        commits: Array<{ subject: string }>;
      }
    ).commits;
    assert(history.length >= 2);
    assert(history.some(({ subject }) => subject.includes("Local component fixture")));
    assert(history.some(({ subject }) => subject.includes("Update retry window")));
    const graphResult = (
      (
        await execute("project-brain_codegraph_explore", {
          projectPath: repositoryA,
          query: "retryWindowMinutes",
          maxNodes: 20,
          includeCode: true,
        })
      ).structuredContent as { result: { nodes: Array<{ name: string }> } }
    ).result;
    assert(graphResult.nodes.some(({ name }) => name === "retryWindowMinutes"));
    const explanation = packetFrom(
      await execute("project-brain_brain_explain", {
        projectPath: repositoryA,
        symbol: "retryWindowMinutes",
        path: "service.ts",
        responseFormat: "structured",
      }),
    );
    assert(
      explanation.items.some((item) => item.provenance.some((ref) => ref.kind === "code" && ref.path === "service.ts")),
    );
    const codeSearchInput = {
      projectPath: repositoryA,
      query: "retryWindowMinutes",
      sources: ["code"],
      responseFormat: "structured" as const,
    };
    const codeBeforeChange = packetFrom(await execute("project-brain_brain_search", codeSearchInput));
    const codeItem = codeBeforeChange.items.find((item) => item.excerpt.includes("retryWindowMinutes"));
    assert(codeItem?.excerpt.includes("= 5"));
    writeFileSync(join(repositoryA, "service.ts"), "export const retryWindowMinutes = 7;\n");
    const updatedGraph = (
      (
        await execute("project-brain_codegraph_explore", {
          projectPath: repositoryA,
          query: "retryWindowMinutes",
          maxNodes: 20,
          includeCode: true,
        })
      ).structuredContent as { result: { nodes: Array<{ name: string; snippet?: string }> } }
    ).result;
    assert(updatedGraph.nodes.some((node) => node.name === "retryWindowMinutes" && node.snippet?.includes("= 7")));
    const codeAfterChange = packetFrom(
      await execute("project-brain_brain_search", { ...codeSearchInput, cursor: codeBeforeChange.cursor }),
    );
    assert(
      codeAfterChange.items.some((item) => item.excerpt.includes("retryWindowMinutes") && item.excerpt.includes("= 7")),
    );
    execFileSync("git", ["add", "service.ts"], { cwd: repositoryA, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Phase 2 Fixture",
        "-c",
        "user.email=phase2@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Change retry window implementation",
      ],
      { cwd: repositoryA, stdio: "ignore" },
    );
    const pendingPath = join(repositoryA, "pending.ts");
    writeFileSync(
      pendingPath,
      `${Array.from({ length: 2_000 }, (_, index) => `export const pendingMarker${index} = ${JSON.stringify(randomUUID())};`).join("\n")}\n`,
    );
    let pending = await localBrain.code.status(repositoryA);
    for (let attempt = 0; attempt < 100 && !pending.pendingFiles.includes("pending.ts"); attempt += 1) {
      await pause(50);
      pending = await localBrain.code.status(repositoryA);
    }
    assert.equal(pending.state, "pending");
    assert(pending.pendingFiles.includes("pending.ts"));
    assert("exploreContext" in localBrain.code);
    const staleGraph = await localBrain.code.exploreContext({
      projectRoot: repositoryA,
      query: "retryWindowMinutes",
      maxNodes: 20,
      includeCode: true,
    });
    // The watcher may finish between status and retrieval; freshness must
    // describe the pending-file snapshot returned by that retrieval.
    assert.equal(staleGraph.state, staleGraph.pendingFiles.length > 0 ? "stale" : "ready");
    execFileSync("git", ["add", "pending.ts"], { cwd: repositoryA, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Phase 2 Fixture",
        "-c",
        "user.email=phase2@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Add pending graph marker",
      ],
      { cwd: repositoryA, stdio: "ignore" },
    );

    const remember = async (
      operationKey: string,
      scope: { kind: "system" | "domain" | "org"; name?: string },
      title: string,
      content: string,
    ) => {
      const response = await authorized("/v1/memories", {
        schemaVersion: 1,
        operationKey,
        scope,
        kind: "fact",
        title,
        content,
        confidence: "high",
        wake: true,
        reviewAfter: fact.reviewAfter,
        provenance: [
          {
            sourceType: "human",
            actor: "alice",
            repository: "repository-a",
            path: "catalog-info.yaml",
            capturedAt: new Date().toISOString(),
          },
        ],
      });
      assert(response.ok, "scoped fact write rejected");
      return (await response.json()) as { outcomes: Array<{ recordId: string }> };
    };
    const domainResult = await remember(
      `${operation}-domain`,
      { kind: "domain", name: "payments" },
      "Payments retry convention",
      "Payments teams use idempotency keys when retrying a failed request.",
    );
    const orgResult = await remember(
      `${operation}-org`,
      { kind: "org" },
      "Service health interface",
      "Every company service emits a stable health signal for operators.",
    );
    const domainRecordId = domainResult.outcomes[0]?.recordId;
    const orgRecordId = orgResult.outcomes[0]?.recordId;
    assert(domainRecordId && orgRecordId);

    stage = "fresh context process L0 retrieval and outbound privacy";
    const l0RequestCount = capturedSharedRequests.length;
    const freshContext = await openLocalContext();
    try {
      const l0 = await callContextTool(freshContext.client, "brain_wake", {
        projectPath: repositoryB,
        level: 0,
      });
      assert(!l0.isError);
      assert(l0.content.some((block) => block.type === "text" && block.text.includes("No new retrieved context.")));
      assert((l0.structuredContent?.estimatedTokens as number) <= 150);
      assert.equal(capturedSharedRequests.length, l0RequestCount);
      const structuredL0 = await callContextTool(freshContext.client, "brain_wake", {
        projectPath: repositoryB,
        level: 0,
        responseFormat: "structured",
      });
      assert(structuredL0.isError);
      assert(structuredL0.content.some((block) => block.type === "text" && block.text === "context_invalid"));
      assert.equal(capturedSharedRequests.length, l0RequestCount);
    } finally {
      await freshContext.close();
    }

    stage = "repository B retrieval, provenance, cursor, and representation bounds";
    const search = {
      projectPath: repositoryB,
      query: "Checkout retries backoff",
      sources: ["shared_memory"],
      maxTokens: 1500,
      responseFormat: "structured",
    };
    const retrieved = await execute("project-brain_brain_search", search);
    const packet = ContextPacketSchema.parse(retrieved.structuredContent);
    assert(
      packet.items.some((item) =>
        item.provenance.some((ref) => ref.kind === "shared_memory" && ref.memoryId === recordId),
      ),
    );
    assert(packet.items.every((item) => item.source === "shared_memory"));
    assert(!JSON.stringify(retrieved).includes("component-a-private-evidence"));
    assert(!JSON.stringify(retrieved).includes("component-b-private-evidence"));
    assert(Buffer.byteLength(JSON.stringify(retrieved)) <= 16 * 1024);
    assert(packet.estimatedTokens <= 1500);
    const repeated = ContextPacketSchema.parse(
      (await execute("project-brain_brain_search", { ...search, cursor: packet.cursor })).structuredContent,
    );
    assert.equal(repeated.items.length, 0);
    await remember(
      `${operation}-changed-system`,
      { kind: "system", name: "checkout" },
      fact.title,
      "Checkout retries use a six-minute backoff before escalating.",
    );
    const changedSearch = {
      ...search,
      query: "Checkout retries backoff",
      cursor: packet.cursor,
      responseFormat: "structured" as const,
    };
    const changedResult = await execute("project-brain_brain_search", changedSearch);
    const changedPacket = packetFrom(changedResult);
    const changedSystemItem = changedPacket.items.find((item) => item.excerpt.includes("six-minute backoff"));
    assert(changedSystemItem);
    const changedSystemId = changedSystemItem.provenance.find((ref) => ref.kind === "shared_memory")?.memoryId;
    assert(changedSystemId);
    const markdownChanged = await execute("project-brain_brain_search", {
      ...changedSearch,
      responseFormat: "markdown",
    });
    assertSingleProseRepresentation(markdownChanged, "Checkout retries use a six-minute backoff");
    const structuredChanged = await execute("project-brain_brain_search", {
      ...changedSearch,
      responseFormat: "structured",
    });
    assertSingleProseRepresentation(structuredChanged, "Checkout retries use a six-minute backoff");

    stage = "local context subprocess restart and ephemeral cursor reset";
    const processOne = await openLocalContext();
    let restartCursor: string;
    try {
      const firstAfterRestart = packetFrom(
        await callContextTool(processOne.client, "brain_search", {
          projectPath: repositoryB,
          query: "Checkout retries backoff",
          sources: ["shared_memory"],
          responseFormat: "structured",
        }),
      );
      assert(firstAfterRestart.items.some((item) => item.excerpt.includes("six-minute backoff")));
      restartCursor = firstAfterRestart.cursor;
    } finally {
      await processOne.close();
    }
    const processTwo = await openLocalContext();
    try {
      const resetPacket = packetFrom(
        await callContextTool(processTwo.client, "brain_search", {
          projectPath: repositoryB,
          query: "Checkout retries backoff",
          sources: ["shared_memory"],
          cursor: restartCursor,
          responseFormat: "structured",
        }),
      );
      assert(resetPacket.omitted.reasons.includes("cursor_reset"));
      assert(resetPacket.items.some((item) => item.excerpt.includes("six-minute backoff")));
      const persistedGraph = await callContextTool(processTwo.client, "codegraph_explore", {
        projectPath: repositoryA,
        query: "retryWindowMinutes",
        maxNodes: 20,
        includeCode: true,
      });
      const persistedNodes = (persistedGraph.structuredContent as { result: { nodes: Array<{ name: string }> } }).result
        .nodes;
      assert(persistedNodes.some(({ name }) => name === "retryWindowMinutes"));
    } finally {
      await processTwo.close();
    }

    const cSystem = packetFrom(
      await execute("project-brain_brain_search", {
        projectPath: repositoryC,
        query: "Checkout retries backoff",
        sources: ["shared_memory"],
        responseFormat: "structured",
      }),
    );
    assert(
      !cSystem.items.some((item) =>
        item.provenance.some(
          (ref) => ref.kind === "shared_memory" && [recordId, changedSystemId].includes(ref.memoryId),
        ),
      ),
    );
    const cOrg = packetFrom(
      await execute("project-brain_brain_search", {
        projectPath: repositoryC,
        query: "company service health signal",
        sources: ["shared_memory"],
        responseFormat: "structured",
      }),
    );
    assert(
      cOrg.items.some((item) =>
        item.provenance.some((ref) => ref.kind === "shared_memory" && ref.memoryId === orgRecordId),
      ),
    );
    const bDomain = packetFrom(
      await execute("project-brain_brain_search", {
        projectPath: repositoryB,
        query: "Payments idempotency keys retries",
        sources: ["shared_memory"],
        responseFormat: "structured",
      }),
    );
    assert(
      bDomain.items.some((item) =>
        item.provenance.some((ref) => ref.kind === "shared_memory" && ref.memoryId === domainRecordId),
      ),
    );
    const cDomain = packetFrom(
      await execute("project-brain_brain_search", {
        projectPath: repositoryC,
        query: "Payments idempotency keys retries",
        sources: ["shared_memory"],
        responseFormat: "structured",
      }),
    );
    assert(
      !cDomain.items.some((item) =>
        item.provenance.some((ref) => ref.kind === "shared_memory" && ref.memoryId === domainRecordId),
      ),
    );

    const wake = await execute("project-brain_brain_wake", { projectPath: repositoryB, level: 0 });
    assert((wake.structuredContent?.estimatedTokens as number) <= 150);
    stage = "wake levels and shared-fact budgets";
    const wakeL1 = await execute("project-brain_brain_wake", {
      projectPath: repositoryB,
      level: 1,
      maxTokens: 500,
      responseFormat: "structured",
    });
    const wakePacket = packetFrom(wakeL1);
    assert(wakePacket.estimatedTokens <= 500);
    const sharedWake = wakePacket.items.filter((item) => item.source === "shared_memory");
    assert(sharedWake.length <= 3);
    assert(Math.ceil(sharedWake.reduce((sum, item) => sum + Array.from(item.excerpt).length, 0) / 3) <= 200);
    const markdownWake = await execute("project-brain_brain_wake", {
      projectPath: repositoryB,
      level: 1,
      maxTokens: 500,
      responseFormat: "markdown",
    });
    const wakeText = markdownWake.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const eligibleWake = (
      await execute("shared-memory_memory_search", {
        purpose: "wake",
        cascade: { system: "checkout", domain: "payments", includeOrg: true },
        limit: 3,
      })
    ).structuredContent as {
      records: Array<{
        record: {
          content: string;
          status: string;
          confidence: string;
          wake: boolean;
          reviewAfter: string;
        };
      }>;
    };
    const deliveredWake = eligibleWake.records.filter(({ record }) => wakeText.includes(record.content));
    assert(deliveredWake.length > 0 && deliveredWake.length <= 3);
    assert(Math.ceil(deliveredWake.reduce((sum, { record }) => sum + Array.from(record.content).length, 0) / 3) <= 200);
    assert((markdownWake.structuredContent?.estimatedTokens as number) <= 500);
    for (const { record } of deliveredWake) {
      assert.equal(record.status, "active");
      assert.equal(record.confidence, "high");
      assert(record.wake && record.reviewAfter >= new Date().toISOString().slice(0, 10));
      assert(!JSON.stringify(markdownWake.structuredContent).includes(record.content));
    }
    for (const item of sharedWake) {
      const sharedRecord = (
        await execute("shared-memory_memory_query", {
          id: item.provenance.find((ref) => ref.kind === "shared_memory")?.memoryId,
        })
      ).structuredContent as {
        record: { confidence: string; status: string; wake: boolean; reviewAfter?: string };
      };
      assert.equal(sharedRecord.record.status, "active");
      assert.equal(sharedRecord.record.confidence, "high");
      assert.equal(sharedRecord.record.wake, true);
      assert(
        !sharedRecord.record.reviewAfter || sharedRecord.record.reviewAfter >= new Date().toISOString().slice(0, 10),
      );
    }
    for (const [level, maxTokens] of [
      [2, 1_500],
      [3, 3_000],
    ] as const) {
      const sharedRequestsBeforeWake = capturedSharedRequests.length;
      const wakeResult = await execute("project-brain_brain_wake", {
        projectPath: repositoryB,
        level,
        task: "Find the current checkout retry policy",
        maxTokens,
        responseFormat: "structured",
      });
      assert(packetFrom(wakeResult).estimatedTokens <= maxTokens);
      assert(capturedSharedRequests.length > sharedRequestsBeforeWake);
    }

    stage = "reviewed publication replacement, removal, and admin jobs";
    const company = join(state, "config", "company");
    const key = sourceKey("company", "knowledge.md", "system:checkout");
    const publish = async (revision: string, suffix: string, content?: string) => {
      const result = await authorized(
        `/v1/publications/${key}`,
        {
          schemaVersion: 1,
          operationKey: `${operation}-${suffix}`,
          revision,
          repository: "company",
          path: "knowledge.md",
          scope: { kind: "system", name: "checkout" },
          owner: "team-payments",
          chunks: content
            ? [
                {
                  chunkKey: "policy",
                  heading: "Policy",
                  kind: "fact",
                  title: "Reviewed policy",
                  content,
                  confidence: "high",
                  wake: false,
                  provenance: [
                    {
                      sourceType: "git",
                      actor: "team-payments",
                      repository: "company",
                      path: "knowledge.md",
                      commitSha: revision,
                      capturedAt: new Date().toISOString(),
                    },
                  ],
                },
              ]
            : [],
        },
        admin,
        "PUT",
      );
      assert(result.ok, "publication rejected");
      return result.json() as Promise<{ created: number; updated: number; invalidated: number }>;
    };
    assert.equal(
      (await publish(fixture.revision, "publish", "Reviewed checkout policy: retry safely before escalation.\n"))
        .created,
      1,
    );
    writeFileSync(join(company, "knowledge.md"), "Reviewed replacement policy: retry for five minutes.\n");
    execFileSync("git", ["add", "knowledge.md"], { cwd: company, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Phase 2 Fixture",
        "-c",
        "user.email=phase2@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Reviewed replacement",
      ],
      { cwd: company, stdio: "ignore" },
    );
    const nextRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: company, encoding: "utf8" }).trim();
    assert.equal(
      (await publish(nextRevision, "replace", "Reviewed replacement policy: retry for five minutes.\n")).updated,
      1,
    );
    execFileSync("git", ["rm", "--quiet", "knowledge.md"], { cwd: company, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Phase 2 Fixture",
        "-c",
        "user.email=phase2@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Reviewed removal",
      ],
      { cwd: company, stdio: "ignore" },
    );
    const removal = execFileSync("git", ["rev-parse", "HEAD"], { cwd: company, encoding: "utf8" }).trim();
    assert.equal((await publish(removal, "remove")).invalidated, 1);
    stage = "reviewed team publication and cross-team Git provenance";
    const teamPath = "teams/team-payments/.wagglebot/public.md";
    const teamContent = "Payments policy requires an idempotency key before retrying an operation.\n";
    mkdirSync(join(company, "teams", "team-payments", ".wagglebot"), { recursive: true, mode: 0o755 });
    writeFileSync(join(company, teamPath), teamContent, { mode: 0o644 });
    execFileSync("git", ["add", teamPath], { cwd: company, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Phase 2 Fixture",
        "-c",
        "user.email=phase2@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Reviewed team publication",
      ],
      { cwd: company, stdio: "ignore" },
    );
    const teamRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: company, encoding: "utf8" }).trim();
    const teamKey = sourceKey("company", teamPath, "domain:payments");
    const teamPublication = await authorized(
      `/v1/publications/${teamKey}`,
      {
        schemaVersion: 1,
        operationKey: `${operation}-team-publication`,
        revision: teamRevision,
        repository: "company",
        path: teamPath,
        scope: { kind: "domain", name: "payments" },
        owner: "team-payments",
        chunks: [
          {
            chunkKey: "team-policy",
            heading: "Policy",
            kind: "fact",
            title: "Payments team policy",
            content: teamContent,
            confidence: "high",
            wake: false,
            provenance: [
              {
                sourceType: "git",
                actor: "team-payments",
                repository: "company",
                path: teamPath,
                commitSha: teamRevision,
                capturedAt: new Date().toISOString(),
              },
            ],
          },
        ],
      },
      admin,
      "PUT",
    );
    assert(teamPublication.ok);
    const crossTeam = await execute("shared-memory_memory_search", {
      purpose: "query",
      query: "Payments policy requires an idempotency key before retrying an operation",
      cascade: { system: "inventory", domain: "inventory", includeOrg: true },
      scopes: [{ kind: "domain", name: "payments" }],
    });
    const crossTeamRecords = crossTeam.structuredContent as {
      records: Array<{ record: { content: string; provenance: Array<{ commitSha?: string; path?: string }> } }>;
    };
    assert(
      crossTeamRecords.records.some(
        ({ record }) =>
          record.content === teamContent &&
          record.provenance.some((entry) => entry.commitSha === teamRevision && entry.path === teamPath),
      ),
    );

    for (const action of ["rescan", "reindex", "run-once"]) {
      const response = await authorized(
        `/v1/admin/${action}`,
        { schemaVersion: 1, operationKey: `${operation}-${action}` },
        admin,
      );
      assert(response.ok, "admin action rejected");
      if (action === "run-once") assert.equal(((await response.json()) as { failed: number }).failed, 0);
    }
    stage = "memory restart and durable idempotency replay";
    compose("restart", "memory");
    await waitReady();
    const replay = await authorized("/v1/memories", fact);
    assert(replay.ok);
    assert.deepEqual(await replay.json(), original);
    const privacy = compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "wagglebot",
      "-d",
      "wagglebot",
      "-Atc",
      "SELECT count(*) FROM wagglebot_memories WHERE text LIKE '%private-evidence%' OR provenance::text LIKE '%private-evidence%' OR text LIKE '%synthetic-credential-value%'",
    );
    assert.equal(privacy.trim(), "0");
    const auditPrivacy = compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "wagglebot",
      "-d",
      "wagglebot",
      "-Atc",
      "SELECT count(*) FROM wagglebot_memory_schema_metadata WHERE worker_state::text LIKE '%private-evidence%'",
    );
    assert.equal(auditPrivacy.trim(), "0");
    assert(capturedSharedRequests.length > 0);
    const sharedRequestText = JSON.stringify(capturedSharedRequests);
    for (const value of [
      state,
      repositoryA,
      repositoryB,
      repositoryC,
      admin,
      memoryToken,
      registryToken,
      fact.content,
      "Checkout retries use a six-minute backoff before escalating.",
      "Payments teams use idempotency keys when retrying a failed request.",
      "Every company service emits a stable health signal for operators.",
      "Payments teams now use request fingerprints when retrying a failed request.",
      "component-a-private-evidence",
      "component-b-private-evidence",
      "component-c-private-evidence",
      "export const retryWindowMinutes",
      "DECISIONS.md",
      "transcript",
    ])
      assert(!sharedRequestText.includes(value), "prohibited local material found in captured shared requests");
    for (const body of capturedSharedRequests) {
      assert(Object.keys(body).every((key) => ["schemaVersion", "purpose", "cascade", "query", "limit"].includes(key)));
      assert(!JSON.stringify(body).includes("/Users/"));
    }
    compose("run", "--rm", "migrate", "db:check");
    const logs = compose("logs", "--no-color");
    for (const value of [
      admin,
      memoryToken,
      registryToken,
      fact.content,
      search.query,
      "component-a-private-evidence",
      "component-b-private-evidence",
    ])
      assert(!logs.includes(value), "prohibited material found in service logs");

    stage = "offline local retrieval and Context Bridge isolation";
    compose("stop", "gateway", "memory", "registry", "auth");
    const local = ContextPacketSchema.parse(
      (
        await execute("project-brain_brain_search", {
          projectPath: repositoryB,
          query: "Retry ownership",
          sources: ["local_memory"],
          maxTokens: 1500,
          responseFormat: "structured",
        })
      ).structuredContent,
    );
    assert(local.items.some((item) => item.excerpt.includes("component-b-private-evidence")));
    assert(!JSON.stringify(local).includes("component-a-private-evidence"));
    const localC = ContextPacketSchema.parse(
      (
        await execute("project-brain_brain_search", {
          projectPath: repositoryC,
          query: "Inventory component architecture",
          sources: ["local_memory"],
          maxTokens: 1500,
          responseFormat: "structured",
        })
      ).structuredContent,
    );
    assert(localC.items.some((item) => item.excerpt.includes("component-c-private-evidence")));
    assert(!JSON.stringify(localC).includes("component-a-private-evidence"));
    assert(!JSON.stringify(localC).includes("component-b-private-evidence"));
    const exported = await execute("project-brain_brain_context_export", {
      projectPath: repositoryA,
      goal: "Continue the reviewed migration",
      decisions: [],
      openQuestions: [],
      evidence: [],
      ttlSeconds: 60,
      providerState: { localBrain: "ready", sharedMemory: "not_requested" },
    });
    const handle = exported.structuredContent?.handle;
    assert(typeof handle === "string");
    assert(
      JSON.stringify(
        await execute("project-brain_brain_context_import", { projectPath: repositoryB, handle }),
      ).includes("context_project_mismatch"),
    );
    const expiring = await execute("project-brain_brain_context_export", {
      projectPath: repositoryA,
      goal: "Inspect a short lived packet",
      decisions: [],
      openQuestions: [],
      evidence: [],
      ttlSeconds: 1,
      providerState: { localBrain: "ready", sharedMemory: "not_requested" },
    });
    const expiringHandle = expiring.structuredContent?.handle;
    assert(typeof expiringHandle === "string");
    await pause(1100);
    assert(
      JSON.stringify(
        await execute("project-brain_brain_context_import", { projectPath: repositoryA, handle: expiringHandle }),
      ).includes("context_expired"),
    );
    await execute("project-brain_brain_context_revoke", { projectPath: repositoryA, handle: expiringHandle });
    await execute("project-brain_brain_context_revoke", { projectPath: repositoryA, handle });
    assert.equal((await localBrain.memory.read(repositoryA))?.bundleHash, beforeA);
    assert.equal((await localBrain.memory.read(repositoryB))?.bundleHash, beforeB);
    assert.equal((await localBrain.memory.read(repositoryC))?.bundleHash, beforeC);
    for (const repository of [repositoryA, repositoryB, repositoryC])
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim(), "");
    console.log(
      "Phase 2 Compose smoke passed: real SSH auth, registry, PostgreSQL/model/scanner, hub/MCP, cross-repository context, publication/admin, restart replay, offline local retrieval, and Bridge isolation.",
    );
  } finally {
    await client.close().catch(() => undefined);
    await runtime?.close();
    await server?.stop(true);
    await sharedProxy?.stop(true);
    await localBrain.close();
    agent.kill();
    await agent.exited;
    if (previousSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previousSocket;
  }
}

if (import.meta.main) {
  try {
    await smokePhase2(resolve(process.argv[2] ?? ""));
  } catch (error) {
    const locations =
      error instanceof Error
        ? [...(error.stack ?? "").matchAll(/phase2-compose\.ts:\d+:\d+/gu)].map(([location]) => location).join(", ")
        : "";
    console.error(`Phase 2 Compose smoke failed at: ${stage}${locations ? ` (${locations})` : ""}.`);
    process.exitCode = 1;
  }
}
