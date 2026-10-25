import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ensureLocalMemoryBundle } from "../packages/local-brain/src/memory/lifecycle";

const run = (command: string, args: string[], cwd?: string): string =>
  execFileSync(
    command,
    command === "git"
      ? [
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ]
      : args,
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
const write = (path: string, content: string, mode = 0o644): void => {
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
};

const chmodPublicTree = (directory: string): void => {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) chmodPublicTree(path);
    else if (entry.isFile()) chmodSync(path, 0o644);
  }
};

export async function initializePhase2(state: string, port = 8443): Promise<void> {
  if (!isAbsolute(state) || /[\r\n$]/u.test(state) || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("an absolute new state directory and port 1024..65535 are required");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const config = join(state, "config");
  const client = join(state, "client");
  const bin = join(state, "bin");
  for (const path of [config, client, bin]) mkdirSync(path, { mode: 0o755 });
  chmodSync(config, 0o755);
  chmodSync(client, 0o700);
  chmodSync(bin, 0o755);
  const dockerConfig = join(client, "docker");
  mkdirSync(dockerConfig, { mode: 0o700 });
  write(
    join(dockerConfig, "config.json"),
    JSON.stringify({
      cliPluginsExtraDirs: ["/opt/homebrew/lib/docker/cli-plugins", "/usr/local/lib/docker/cli-plugins"].filter(
        existsSync,
      ),
    }),
    0o600,
  );
  const issuer = `https://localhost:${port}`;
  const key = join(client, "id_ed25519");
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const publicKey = readFileSync(`${key}.pub`, "utf8").trim();
  const auth = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  write(join(config, "auth-private.pem"), auth.privateKey);
  write(join(config, "auth-public.pem"), auth.publicKey);

  // The host state directory protects the keys. Only the required files are
  // mounted into each container; neither the CA key nor client SSH key is mounted.
  const caKey = join(client, "ca.key");
  const ca = join(config, "ca.crt");
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "30",
    "-subj",
    "/CN=Wagglebot local Phase 2 CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    caKey,
    "-out",
    ca,
  ]);
  chmodSync(caKey, 0o600);
  chmodSync(ca, 0o644);
  for (const name of ["tls", "postgres"]) {
    const certKey = join(config, `${name}.key`);
    const csr = join(client, `${name}.csr`);
    const extensions = join(client, `${name}.ext`);
    write(
      extensions,
      `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,DNS:postgres,IP:127.0.0.1\n`,
      0o600,
    );
    run("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${name === "tls" ? "localhost" : "postgres"}`,
      "-keyout",
      certKey,
      "-out",
      csr,
    ]);
    run("openssl", [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAserial",
      join(client, "ca.srl"),
      "-CAcreateserial",
      "-days",
      "30",
      "-sha256",
      "-extfile",
      extensions,
      "-out",
      join(config, `${name}.crt`),
    ]);
    chmodSync(certKey, 0o644);
    chmodSync(join(config, `${name}.crt`), 0o644);
  }

  const company = join(config, "company");
  mkdirSync(company);
  mkdirSync(join(company, "company"));
  mkdirSync(join(company, "teams", "team-payments"), { recursive: true });
  write(join(company, "wagglebot.yaml"), "version: 1\nkind: company\n");
  write(join(company, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.0.0" } }));
  const catalog = `apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: { name: team-payments }\nspec: { members: [alice] }\n---\nkind: Group\nmetadata: { name: team-operations }\nspec: { members: [alice] }\n---\nkind: Domain\nmetadata: { name: payments }\nspec: { owner: team-payments }\n---\nkind: Domain\nmetadata: { name: inventory }\nspec: { owner: team-operations }\n---\nkind: System\nmetadata: { name: checkout }\nspec: { owner: team-payments, domain: payments }\n---\nkind: System\nmetadata: { name: inventory }\nspec: { owner: team-operations, domain: inventory }\n---\nkind: User\nmetadata:\n  name: alice\n  annotations:\n    wagglebot.dev/ssh-key: ${JSON.stringify(publicKey)}\n    wagglebot.dev/org-owner: "true"\nspec: { memberOf: [team-payments, team-operations] }\n`;
  write(join(company, "company", "catalog.yaml"), catalog);
  // The auth resolver reads a single catalog file, while the other services
  // read the normal company repository layout.
  write(join(company, "catalog"), catalog);
  write(join(company, "tool_catalog.yaml"), "version: 1\ntitle: Phase 2 tools\nfamilies: []\n");
  const configuredEnv = Object.fromEntries(
    [
      "MEMORY_WORKER_URL",
      "WAGGLEBOT_COMPANY_ROOT",
      "MCP_HUB_AUTH_URL",
      "MCP_HUB_AUTH_USERNAME",
      "MCP_HUB_AUTH_PUBLIC_KEY_FILE",
      "SSH_AUTH_SOCK",
      "NODE_EXTRA_CA_CERTS",
    ].map((name) => [name, `\u0024{${name}}`]),
  );
  write(
    join(company, "company", "registry.yaml"),
    JSON.stringify({
      proxies: [
        {
          namespace: "shared-memory",
          mode: "remote_http",
          endpoint: `${issuer}/mcp`,
          auth: {
            scheme: { kind: "bearer" },
            source: { from: "env", var: "PHASE2_MEMORY_TOKEN" },
          },
        },
        {
          namespace: "project-brain",
          mode: "stdio_cmd",
          command: "wagglebot-context-engine",
          env: {
            CODEGRAPH_TELEMETRY: "0",
            HOME: "${PHASE2_CLIENT_HOME}",
            ...configuredEnv,
          },
        },
      ],
    }),
  );
  write(join(company, "teams", "team-payments", "registry.yaml"), "proxies: []\n");
  write(join(company, "knowledge.md"), "Reviewed checkout policy: retry safely before escalation.\n");
  run("git", ["init", "--quiet", company]);
  run("git", ["add", "."], company);
  run(
    "git",
    [
      "-c",
      "user.name=Phase 2 Fixture",
      "-c",
      "user.email=phase2@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Reviewed company fixture",
    ],
    company,
  );
  const revision = run("git", ["rev-parse", "HEAD"], company);
  write(join(config, "publication-repositories.json"), JSON.stringify({ company: "/config/company" }));

  for (const [name, system] of [
    ["a", "checkout"],
    ["b", "checkout"],
    ["c", "inventory"],
  ] as const) {
    const repository = join(state, `repository-${name}`);
    mkdirSync(repository, { mode: 0o755 });
    chmodSync(repository, 0o755);
    run("git", ["init", "--quiet", repository]);
    write(
      join(repository, "catalog-info.yaml"),
      `kind: Component\nmetadata: { name: component-${name} }\nspec: { system: ${system}, owner: ${system === "checkout" ? "team-payments" : "team-operations"} }\n`,
    );
    ensureLocalMemoryBundle(repository);
    write(
      join(repository, ".agents", "memory", "component.md"),
      `---\ntype: Component Overview\ntitle: Component ${name} local architecture\n---\n\nThe component-${name}-private-evidence stays local. Retry ownership belongs to this repository.\n`,
    );
    ensureLocalMemoryBundle(repository);
    write(join(repository, "DECISIONS.md"), "Decision: retry transient failures with a bounded backoff.\n");
    write(join(repository, "service.ts"), "export const retryWindowMinutes = 3;\n");
    run("git", ["add", "."], repository);
    run(
      "git",
      [
        "-c",
        "user.name=Phase 2 Fixture",
        "-c",
        "user.email=phase2@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Local component fixture",
      ],
      repository,
    );
    write(join(repository, "service.ts"), "export const retryWindowMinutes = 5;\n");
    run("git", ["add", "service.ts"], repository);
    run(
      "git",
      [
        "-c",
        "user.name=Phase 2 Fixture",
        "-c",
        "user.email=phase2@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Update retry window",
      ],
      repository,
    );
    chmodPublicTree(repository);
  }
  chmodPublicTree(company);
  const workspace = resolve(import.meta.dir, "..");
  symlinkSync(
    join(workspace, "packages", "cli", "bin", "wagglebot-context-engine.js"),
    join(state, "bin", "wagglebot-context-engine"),
  );
  const environment = [
    `STACK_STATE_DIR=${JSON.stringify(state)}`,
    `STACK_PORT=${port}`,
    `STACK_ISSUER=${issuer}`,
    `STACK_REVISION=${revision}`,
    `STACK_DATABASE_PASSWORD=${randomBytes(24).toString("hex")}`,
    `STACK_ADMIN_TOKEN=${randomBytes(32).toString("hex")}`,
  ].join("\n");
  write(join(state, ".env"), `${environment}\n`, 0o600);
  write(join(state, "fixture.json"), JSON.stringify({ schemaVersion: 1, issuer, revision, workspace }), 0o600);
}

if (import.meta.main) {
  try {
    await initializePhase2(resolve(process.argv[2] ?? ""), Number(process.argv[3] ?? "8443"));
    console.log("Phase 2 state initialized; private keys and environment remain in the protected state directory.");
  } catch {
    console.error(
      "Phase 2 initialization failed; use a new absolute directory and available Git, OpenSSH, and OpenSSL commands.",
    );
    process.exitCode = 1;
  }
}
