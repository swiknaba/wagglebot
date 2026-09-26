import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startBackupSet } from "../backup";
import type { Harness } from "../harness";
import { HARNESSES } from "../harness";
import type { ProxyConfig } from "../registry";
import { loadRegistry } from "../registry";
import { createReporter } from "../report";
import { missingEnvVars, proxyToClaudeEntry, runWriteMcp } from "./write-mcp";

const quiet = () => createReporter(() => {}, false);
for (const command of ["server", "personal-server"]) {
  test(`normal MCP sync preserves unowned collisions (${command}) after company removal`, () => {
    const home = mkdtempSync(join(tmpdir(), "wgl-personal-mcp-"));
    const harness = HARNESSES.find((h) => h.name === "cursor");
    if (!harness) throw new Error("Missing Cursor fixture");
    const path = join(home, ".cursor/mcp.json");
    mkdirSync(dirname(path), { recursive: true });
    const personal = { command, args: [], type: "stdio" };
    writeFileSync(path, JSON.stringify({ mcpServers: { shared: personal } }));
    const run = (proxies: ProxyConfig[]) =>
      runWriteMcp({ home, harnesses: [harness], proxies, env: {}, reporter: quiet() });
    expect(run([{ namespace: "shared", mode: "stdio_cmd", command: "server" }])).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.shared).toEqual(personal);
    expect(run([])).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.shared).toEqual(personal);
  });
}
const remote: ProxyConfig = {
  namespace: "example",
  mode: "remote_http",
  endpoint: "https://mcp.example.com/mcp",
  auth: { scheme: { kind: "bearer" }, source: { from: "env", var: "EXAMPLE_TOKEN" } },
};

test("maps a bearer remote to an http entry with an env expansion header", () => {
  expect(proxyToClaudeEntry(remote)).toEqual({
    type: "http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
  });
});

test("maps stdio_npx to a pinned npx command", () => {
  const p: ProxyConfig = {
    namespace: "gh",
    mode: "stdio_npx",
    command: "@example/mcp@1.4.2",
    args: ["--flag"],
    auth: { scheme: { kind: "env", map: { GH_TOKEN: "$SOURCE" } }, source: { from: "env", var: "MY_GH_TOKEN" } },
  };
  expect(proxyToClaudeEntry(p)).toEqual({
    command: "npx",
    args: ["-y", "@example/mcp@1.4.2", "--flag"],
    env: { GH_TOKEN: "${MY_GH_TOKEN}" },
  });
});

test("writes managed entries, preserves foreign entries, removes stale ones", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { personal: { command: "my-mcp" } } }));
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [remote], env: {}, reporter: quiet() });
  const doc1 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(doc1.mcpServers.personal).toEqual({ command: "my-mcp" });
  expect(doc1.mcpServers.example.type).toBe("http");
  expect(JSON.stringify(doc1)).not.toContain("hunter2"); // never a secret value
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [], env: {}, reporter: quiet() }); // registry entry removed
  const doc2 = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  expect(doc2.mcpServers.example).toBeUndefined();
  expect(doc2.mcpServers.personal).toBeDefined();
});

test("a corrupt target file reports failed and exits 1 without crashing", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  writeFileSync(join(home, ".claude.json"), "{ not valid json");
  const r = createReporter(() => {}, false);
  const code = runWriteMcp({ home, harnesses: HARNESSES, proxies: [remote], env: {}, reporter: r });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
});

test("second identical run reports ok", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [remote], env: {}, reporter: quiet() });
  const r = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [remote], env: {}, reporter: r });
  expect(r.counts().updated).toBe(0);
  // Six targets support safe bearer references. Cascade skips this entry.
  expect(r.counts().ok).toBe(6);
});

for (const name of ["cursor", "devin", "kiro"]) {
  test(`${name} writes each target, warns about missing variables, and skips only unsafe entries`, () => {
    const home = mkdtempSync(join(tmpdir(), "wgl-new-mcp-"));
    const harness = HARNESSES.find((h) => h.name === name);
    if (!harness) throw new Error("fixture");
    const lines: string[] = [];
    const unsupported: ProxyConfig = {
      ...remote,
      namespace: "unsupported",
      auth: {
        scheme: { kind: "bearer" },
        source: { from: "literal", value: "do-not-print" },
      } as unknown as ProxyConfig["auth"],
    };
    const plain: ProxyConfig = { namespace: "plain", mode: "stdio_cmd", command: "server" };
    for (const env of [{}, { EXAMPLE_TOKEN: "current-secret-do-not-print" }]) {
      expect(
        runWriteMcp({
          home,
          harnesses: [harness],
          proxies: [unsupported, remote, plain],
          env,
          reporter: createReporter((line) => lines.push(line), false),
        }),
      ).toBe(0);
      for (const target of harness.mcpTargets) {
        const text = readFileSync(join(home, target.path), "utf8");
        const doc = JSON.parse(text);
        expect(doc.mcpServers.plain.command).toBe("server");
        expect(doc.mcpServers.unsupported).toBeUndefined();
        if (target.dialect === "windsurf") expect(doc.mcpServers.example).toBeUndefined();
        else
          expect(doc.mcpServers.example.headers.Authorization).toBe(
            name === "kiro" ? "Bearer ${EXAMPLE_TOKEN}" : "Bearer ${env:EXAMPLE_TOKEN}",
          );
        expect(text).not.toContain("do-not-print");
      }
    }
    expect(lines.join("\n")).toContain("EXAMPLE_TOKEN");
    expect(lines.join("\n")).toContain("not set in this shell");
    expect(lines.join("\n")).toContain("unsupported");
    expect(lines.join("\n")).not.toContain("do-not-print");
  });
}

test("a failed target does not prevent the next target in the same harness", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-targets-"));
  const devin = HARNESSES.find((h) => h.name === "devin");
  if (!devin) throw new Error("fixture");
  mkdirSync(join(home, ".config/devin"), { recursive: true });
  writeFileSync(join(home, ".config/devin/mcp_config.json"), "{broken");
  const plain: ProxyConfig = { namespace: "plain", mode: "stdio_cmd", command: "server" };
  expect(runWriteMcp({ home, harnesses: [devin], proxies: [plain], env: {}, reporter: quiet() })).toBe(1);
  expect(JSON.parse(readFileSync(join(home, ".codeium/windsurf/mcp_config.json"), "utf8")).mcpServers.plain).toEqual({
    command: "server",
    args: [],
  });
});

test("an unchanged overwrite adopts entries for later state-owned removal", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-adopt-"));
  const cursor = HARNESSES.find((h) => h.name === "cursor");
  if (!cursor) throw new Error("fixture");
  const path = join(home, ".cursor/mcp.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: { plain: { type: "stdio", command: "server", args: [] } } }));
  const plain: ProxyConfig = { namespace: "plain", mode: "stdio_cmd", command: "server" };
  expect(
    runWriteMcp({ home, harnesses: [cursor], proxies: [plain], env: {}, reporter: quiet(), overwrite: true }),
  ).toBe(0);
  expect(runWriteMcp({ home, harnesses: [cursor], proxies: [], env: {}, reporter: quiet() })).toBe(0);
  expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toEqual({});
});

test("missingEnvVars includes a variable in a custom header prefix", () => {
  const proxy: ProxyConfig = {
    ...remote,
    auth: {
      scheme: { kind: "header", name: "X-Key", prefix: "${PREFIX} " },
      source: { from: "env", var: "TOKEN" },
    },
  };
  expect(missingEnvVars([proxy], { TOKEN: "secret" })).toEqual(["PREFIX"]);
});

test("JSON overwrite replaces MCP entries in every target and preserves other settings without backups", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-overwrite-"));
  const harnesses = HARNESSES.filter((h) => h.mcpTargets.every((t) => t.format === "json"));
  for (const harness of harnesses)
    for (const target of harness.mcpTargets) {
      mkdirSync(dirname(join(home, target.path)), { recursive: true });
      writeFileSync(
        join(home, target.path),
        JSON.stringify({ theme: "dark", hooks: { custom: [1] }, mcpServers: { foreign: { command: "old" } } }),
      );
    }
  const backups = startBackupSet(join(home, "explicit-backups"));
  const plain: ProxyConfig = { namespace: "plain", mode: "stdio_cmd", command: "server" };
  for (const proxies of [[plain], []]) {
    expect(runWriteMcp({ home, harnesses, proxies, env: {}, reporter: quiet(), overwrite: true, backups })).toBe(0);
    for (const harness of harnesses)
      for (const target of harness.mcpTargets) {
        const doc = JSON.parse(readFileSync(join(home, target.path), "utf8"));
        expect(doc.theme).toBe("dark");
        expect(doc.hooks).toEqual({ custom: [1] });
        expect(Object.keys(doc.mcpServers)).toEqual(proxies.length ? ["plain"] : []);
      }
  }
  expect(existsSync(backups.dir)).toBe(false);
  expect(existsSync(join(home, ".wagglebot/backups"))).toBe(false);
});

test("Codex overwrite removes all MCP tables and preserves unrelated TOML and multiline strings", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-overwrite-toml-"));
  const path = join(home, ".codex/config.toml");
  mkdirSync(dirname(path), { recursive: true });
  const before = [
    'model = "test"',
    'instructions = """',
    "[mcp_servers.decoy]",
    "keep this text",
    '"""',
    "[mcp_servers.personal]",
    'command = "old"',
    "[mcp_servers.personal.env]",
    'TOKEN = "old"',
    '[ "mcp_servers" . "quoted.name" ] # comment',
    'command = "old"',
    "['mcp_servers'.'single']",
    'command = "old"',
    "[profiles.work]",
    'model = "work"',
    "[[mcp_servers.array]]",
    'command = "old"',
    "[mcp_servers]",
    'another = { command = "old" }',
    "[features]",
    "enabled = true",
    "",
  ].join("\n");
  writeFileSync(path, before);
  const backups = startBackupSet(join(home, "explicit-backups"));
  const run = (proxies: ProxyConfig[], overwrite: boolean) =>
    runWriteMcp({
      home,
      harnesses: [codexHarness()],
      proxies,
      env: {},
      reporter: quiet(),
      overwrite,
      backups,
    });
  expect(run([remote], true)).toBe(0);
  const text = readFileSync(path, "utf8");
  expect(text).toContain('instructions = """\n[mcp_servers.decoy]\nkeep this text\n"""');
  expect(text).toContain('[profiles.work]\nmodel = "work"');
  expect(text).toContain("[features]\nenabled = true");
  expect(text).not.toContain('command = "old"');
  expect(text).toContain("[mcp_servers.example]");
  expect(Bun.TOML.parse(text)).toMatchObject({
    model: "test",
    profiles: { work: { model: "work" } },
    mcp_servers: { example: { url: remote.endpoint } },
  });
  expect(run([remote], true)).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(text);
  expect(run([], true)).toBe(0);
  expect(Bun.TOML.parse(readFileSync(path, "utf8"))).not.toHaveProperty("mcp_servers");
  expect(existsSync(backups.dir)).toBe(false);
});

test("Codex overwrite preserves marker text in strings and removes escaped category keys", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-strings-"));
  const path = join(home, ".codex/config.toml");
  mkdirSync(dirname(path), { recursive: true });
  const preamble = [
    'instructions = """',
    "# wagglebot:begin",
    "[mcp_servers.fake]",
    "# wagglebot:end",
    '"""',
    "nested = [",
    '["mcp_servers"],',
    '["value"]',
    "]",
    "literal = '''",
    "[mcp_servers.also_fake]",
    "'''",
    "",
  ].join("\n");
  writeFileSync(path, `${preamble}["\\U0000006dcp_servers".foreign]\ncommand = "old"\n[features]\nenabled = true\n`);
  const run = () =>
    runWriteMcp({ home, harnesses: [codexHarness()], proxies: [remote], env: {}, reporter: quiet(), overwrite: true });
  expect(run()).toBe(0);
  const text = readFileSync(path, "utf8");
  expect(text.startsWith(preamble)).toBe(true);
  const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  expect(Object.keys(parsed.mcp_servers as object)).toEqual(["example"]);
  expect(parsed.features).toEqual({ enabled: true });
  expect(run()).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(text);
});

test("Codex overwrite clears root inline and dotted MCP tables but preserves nested foreign settings", () => {
  for (const category of [
    'mcp_servers = { foreign = { command = "old" } }',
    'mcp_servers.foreign.args = [\n"old"\n]',
  ]) {
    const home = mkdtempSync(join(tmpdir(), "wgl-toml-inline-"));
    const path = join(home, ".codex/config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${category}\nmodel = "test"\n[unrelated]\nmcp_servers = { keep = true }\n`);
    expect(
      runWriteMcp({
        home,
        harnesses: [codexHarness()],
        proxies: [remote],
        env: {},
        reporter: quiet(),
        overwrite: true,
      }),
    ).toBe(0);
    const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed.mcp_servers as object)).toEqual(["example"]);
    expect(parsed.model).toBe("test");
    expect(parsed.unrelated).toEqual({ mcp_servers: { keep: true } });
  }
});

test("an empty registry creates no file", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-mcp-"));
  const r = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: HARNESSES, proxies: [], env: {}, reporter: r });
  expect(existsSync(join(home, ".claude.json"))).toBe(false);
  expect(r.counts().skipped).toBeGreaterThan(0);
});

test("Codex overwrite preserves malformed TOML and continues the next target without backups", () => {
  for (const proxies of [[], [remote]]) {
    const home = mkdtempSync(join(tmpdir(), "wgl-toml-invalid-"));
    const path = join(home, ".codex/config.toml");
    const nextPath = join(home, "next.json");
    mkdirSync(dirname(path), { recursive: true });
    const before = '[mcp_servers.foreign]\ncommand = "old"\n[unrelated] invalid\nkeep = true\n';
    writeFileSync(path, before);
    writeFileSync(nextPath, '{"mcpServers":{"foreign":{}},"keep":true}');
    const harness: Harness = {
      ...codexHarness(),
      mcpTargets: [
        ...codexHarness().mcpTargets,
        { format: "json", path: "next.json", parentKey: "mcpServers", dialect: "cursor" },
      ],
    };
    const backups = startBackupSet(join(home, "backups"));
    const lines: string[] = [];
    const reporter = createReporter((line) => lines.push(line), false);
    expect(runWriteMcp({ home, harnesses: [harness], proxies, env: {}, reporter, overwrite: true, backups })).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(reporter.counts().failed).toBe(1);
    expect(lines.join("\n")).toContain(".codex/config.toml");
    expect(lines.join("\n")).toContain("invalid TOML");
    const next = JSON.parse(readFileSync(nextPath, "utf8"));
    expect(Object.keys(next.mcpServers)).toEqual(proxies.length ? ["example"] : []);
    expect(next.keep).toBe(true);
    expect(existsSync(backups.dir)).toBe(false);
  }
});

test("Codex overwrite preserves unrelated literal and bare keys without decoding literal backslashes", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-literal-"));
  const path = join(home, ".codex/config.toml");
  mkdirSync(dirname(path), { recursive: true });
  const before = String.raw`'\UFFFFFFFF' = true
bare-key = "keep"
['table-\UFFFFFFFF']
keep = true
`;
  writeFileSync(path, before);
  const backups = startBackupSet(join(home, "backups"));
  expect(
    runWriteMcp({
      home,
      harnesses: [codexHarness()],
      proxies: [remote],
      env: {},
      reporter: quiet(),
      overwrite: true,
      backups,
    }),
  ).toBe(0);
  const after = readFileSync(path, "utf8");
  expect(after.startsWith(before)).toBe(true);
  expect(after).toContain("[mcp_servers.example]");
  expect(existsSync(backups.dir)).toBe(false);
});

test("reports every ${VAR} that is not set in the shell", () => {
  const proxies = loadRegistry(
    'proxies:\n  - namespace: a\n    mode: remote_http\n    endpoint: https://x/mcp\n    auth: { scheme: { kind: bearer }, source: { from: env, var: A_TOKEN } }\n  - namespace: b\n    mode: stdio_cmd\n    command: run\n    env: { B_KEY: "${B_KEY}" }\n',
    "r.yaml",
  );
  expect(missingEnvVars(proxies, { A_TOKEN: "x" })).toEqual(["B_KEY"]);
});

test("a file credential source is reported once, not once per harness", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-"));
  const claude = HARNESSES.find((h) => h.name === "claude-code");
  const claudeTarget = claude?.mcpTargets[0];
  if (claude === undefined || claudeTarget === undefined) throw new Error("fixture");
  const twice: Harness[] = [
    claude,
    { ...claude, name: "second", mcpTargets: [{ ...claudeTarget, path: ".second.json" }] },
  ];
  const fileSourced: ProxyConfig = {
    namespace: "vault",
    mode: "remote_http",
    endpoint: "https://v/mcp",
    auth: { scheme: { kind: "bearer" }, source: { from: "file", path: "/x" } },
  };
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  runWriteMcp({ home, harnesses: twice, proxies: [fileSourced], env: {}, reporter: r });
  expect(lines.filter((l) => l.includes("vault")).length).toBe(1);
});

const codexHarness = (): Harness => {
  const codex = HARNESSES.find((h) => h.name === "codex");
  if (codex === undefined || codex.mcpTargets[0] === undefined) throw new Error("fixture");
  return codex;
};

test("a TOML target writes a managed block, keeps the text outside it, and reports ok twice", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt-5"\n\n[mcp_servers.personal]\ncommand = "my-mcp"\n');
  runWriteMcp({ home, harnesses: [codex], proxies: [remote], env: {}, reporter: quiet() });
  const text = readFileSync(join(home, ".codex/config.toml"), "utf8");
  expect(text).toContain('model = "gpt-5"');
  expect(text).toContain("[mcp_servers.personal]");
  expect(text).toContain("# wagglebot:begin");
  expect(text).toContain("[mcp_servers.example]");
  expect(text).toContain('bearer_token_env_var = "EXAMPLE_TOKEN"');
  expect(text).not.toContain("EXAMPLE_TOKEN}"); // the variable name, never an expansion or a value

  const second = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: [codex], proxies: [remote], env: {}, reporter: second });
  expect(second.counts().ok).toBe(1);
  expect(second.counts().updated).toBe(0);
});

test("an emptied registry removes the TOML block and keeps the foreign table", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.personal]\ncommand = "my-mcp"\n');
  const first = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: [codex], proxies: [remote], env: {}, reporter: first });
  expect(first.counts().updated).toBe(1);
  expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toContain("[mcp_servers.example]");

  const emptied = createReporter(() => {}, false);
  runWriteMcp({ home, harnesses: [codex], proxies: [], env: {}, reporter: emptied });
  expect(emptied.counts().updated).toBe(1);
  const text = readFileSync(join(home, ".codex/config.toml"), "utf8");
  expect(text).not.toContain("# wagglebot:begin");
  expect(text).not.toContain("[mcp_servers.example]");
  expect(text).toContain("[mcp_servers.personal]");
});

test("a namespace the TOML file already declares outside the block is failed and left out", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers."example"]\nurl = "https://mine/mcp"\n');
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  const code = runWriteMcp({ home, harnesses: [codex], proxies: [remote], env: {}, reporter: r });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
  expect(lines.join("\n")).toContain("example (codex)");
  expect(lines.join("\n")).toContain("already defined outside the wagglebot block in .codex/config.toml");
  const text = readFileSync(join(home, ".codex/config.toml"), "utf8");
  expect(text).not.toContain("# wagglebot:begin");
  expect(text).toContain('url = "https://mine/mcp"');
});

test("a dialect skip is reported once per harness, and names the harness", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  const target = codex.mcpTargets[0];
  if (target === undefined || target.format !== "toml") throw new Error("fixture");
  const twice: Harness[] = [codex, { ...codex, name: "codex-2", mcpTargets: [{ ...target, path: ".codex/two.toml" }] }];
  const sse: ProxyConfig = { ...remote, mode: "remote_sse" };
  const lines: string[] = [];
  runWriteMcp({
    home,
    harnesses: twice,
    proxies: [sse],
    env: {},
    reporter: createReporter((l) => lines.push(l), false),
  });
  const skips = lines.filter((l) => l.includes("Codex documents no SSE transport"));
  expect(skips).toHaveLength(2);
  expect(skips[0]).toContain("example (codex)");
  expect(skips[1]).toContain("example (codex-2)");
});

test("a harness that can write no entry says so, instead of blaming the registry", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  const onlySse: ProxyConfig = { ...remote, mode: "remote_sse" };
  const lines: string[] = [];
  runWriteMcp({
    home,
    harnesses: [codex],
    proxies: [onlySse],
    env: {},
    reporter: createReporter((l) => lines.push(l), false),
  });
  expect(existsSync(join(home, ".codex/config.toml"))).toBe(false);
  expect(lines.join("\n")).toContain(
    "no MCP server can be written for this harness — every entry was skipped above — file not created",
  );
  expect(lines.join("\n")).not.toContain("no MCP servers in the registry");
});

test("a JSON dialect that expands no ${VAR} skips the credentialed proxy and writes the rest", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-copilot-"));
  const copilot = HARNESSES.find((h) => h.name === "copilot");
  if (copilot === undefined || copilot.mcpTargets[0] === undefined) throw new Error("fixture");
  const plain: ProxyConfig = { namespace: "docs", mode: "remote_http", endpoint: "https://docs.example/mcp" };
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  runWriteMcp({ home, harnesses: [copilot], proxies: [remote, plain], env: {}, reporter: r });
  const text = readFileSync(join(home, ".copilot/mcp-config.json"), "utf8");
  const doc: { mcpServers: Record<string, unknown> } = JSON.parse(text);
  expect(doc.mcpServers.example).toBeUndefined();
  expect(doc.mcpServers.docs).toEqual({ type: "http", url: "https://docs.example/mcp", tools: ["*"] });
  expect(text).not.toContain("EXAMPLE_TOKEN");
  expect(lines.join("\n")).toContain("example (copilot)");
  expect(lines.join("\n")).toContain("does not expand");
});

test("a JSON target that can write no entry says so too", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-copilot-"));
  const copilot = HARNESSES.find((h) => h.name === "copilot");
  if (copilot === undefined || copilot.mcpTargets[0] === undefined) throw new Error("fixture");
  const lines: string[] = [];
  runWriteMcp({
    home,
    harnesses: [copilot],
    proxies: [remote],
    env: {},
    reporter: createReporter((l) => lines.push(l), false),
  });
  expect(existsSync(join(home, ".copilot/mcp-config.json"))).toBe(false);
  expect(lines.join("\n")).toContain(
    "no MCP server can be written for this harness — every entry was skipped above — file not created",
  );
  expect(lines.join("\n")).not.toContain("no MCP servers in the registry");
});

const geminiHarness = (): Harness => {
  const gemini = HARNESSES.find((h) => h.name === "gemini");
  if (gemini === undefined || gemini.mcpTargets[0] === undefined) throw new Error("fixture");
  return gemini;
};

test("a commented settings.json is skipped, and the file keeps every byte", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-gemini-"));
  mkdirSync(join(home, ".gemini"), { recursive: true });
  const before = '{ // my note\n  "theme": "dark" }';
  writeFileSync(join(home, ".gemini/settings.json"), before);
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  // The variable is set, so the only skip line this run prints is the comment one.
  const env = { EXAMPLE_TOKEN: "set-for-the-check" };
  const code = runWriteMcp({ home, harnesses: [geminiHarness()], proxies: [remote], env, reporter: r });
  expect(code).toBe(0);
  expect(r.counts().skipped).toBe(1);
  expect(r.counts().failed).toBe(0);
  expect(lines.join("\n")).toContain(
    "the file contains comments, which a rewrite would lose — remove them, or add the MCP servers by hand",
  );
  expect(readFileSync(join(home, ".gemini/settings.json"), "utf8")).toBe(before);
});

test("a corrupt settings.json still reports failed, comment or not", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-gemini-"));
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini/settings.json"), '{ // my note\n  "theme": ');
  const r = createReporter(() => {}, false);
  const code = runWriteMcp({ home, harnesses: [geminiHarness()], proxies: [remote], env: {}, reporter: r });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
});

test("a single-quoted TOML key counts as a conflicting table too", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), "[mcp_servers.'example']\nurl = \"https://mine/mcp\"\n");
  const r = createReporter(() => {}, false);
  const code = runWriteMcp({ home, harnesses: [codex], proxies: [remote], env: {}, reporter: r });
  expect(code).toBe(1);
  expect(r.counts().failed).toBe(1);
  expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).not.toContain("# wagglebot:begin");
});

test("missingEnvVars reports a variable that only the endpoint names", () => {
  const p: ProxyConfig = { namespace: "k", mode: "remote_http", endpoint: "https://x.example/mcp?key=${API_KEY}" };
  expect(missingEnvVars([p], {})).toEqual(["API_KEY"]);
});

test("missingEnvVars reports a variable that only the command or an argument names", () => {
  const p: ProxyConfig = {
    namespace: "local",
    mode: "stdio_cmd",
    command: "${TOOL_HOME}/bin/mcp",
    args: ["--token=${LOCAL_TOKEN}"],
  };
  expect(missingEnvVars([p], { TOOL_HOME: "/opt/tool" })).toEqual(["LOCAL_TOKEN"]);
});

test("a namespace that only conflicts prints its failed line and no extra skipped line", () => {
  const home = mkdtempSync(join(tmpdir(), "wgl-toml-"));
  const codex = codexHarness();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.example]\nurl = "https://mine/mcp"\n');
  const lines: string[] = [];
  runWriteMcp({
    home,
    harnesses: [codex],
    proxies: [remote],
    env: {},
    reporter: createReporter((l) => lines.push(l), false),
  });
  expect(lines.filter((l) => l.includes("already defined outside the wagglebot block")).length).toBe(1);
  expect(lines.some((l) => l.includes("every entry was skipped above"))).toBe(false);
});
