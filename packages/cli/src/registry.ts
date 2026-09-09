import { parse } from "yaml";

export type AuthScheme =
  | { kind: "none" }
  | { kind: "bearer" }
  | { kind: "header"; name: string; prefix?: string }
  // basic: ${VAR} holds the base64 value of "username:password". A harness expands the variable
  // only, so wagglebot cannot encode it.
  | { kind: "basic" }
  | { kind: "env"; map: Record<string, string> };
export type CredentialSource =
  | { from: "env"; var: string }
  | { from: "file"; path: string }
  | { from: "literal"; value: string };
export type ProxyConfig = {
  namespace: string;
  mode: "remote_http" | "remote_sse" | "stdio_npx" | "stdio_cmd";
  endpoint?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  auth?: { scheme: AuthScheme; source: CredentialSource };
};

// Every key a proxy entry may carry. A typo such as "enpoint" is a hard error, never a silent
// default: the engineer must see which key the loader does not know (P35).
const KNOWN_KEYS = ["namespace", "mode", "endpoint", "command", "args", "env", "auth"];
const MODES = ["remote_http", "remote_sse", "stdio_npx", "stdio_cmd"] as const;
const EXACT_VERSION = /@\d+\.\d+\.\d+([-+][\w.-]+)?$/;
const SCHEME_KINDS = new Set(["none", "bearer", "header", "basic", "env"]);
const SOURCE_FROM = new Set(["env", "file", "literal"]);
const ENV_EXPANSION = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isStringRecord = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === "string");
const isMode = (v: unknown): v is ProxyConfig["mode"] => MODES.some((m) => m === v);

// A function declaration, not an arrow: TypeScript narrows a value only after a call to a
// never-returning function that it can resolve by name.
function fail(file: string, ns: string, message: string): never {
  throw new Error(`${file}: proxy "${ns}": ${message}`);
}

// Checks the auth block field by field. Every kind and every source carries its own required
// fields, so a typo inside auth fails here instead of producing a config the harness ignores.
// The mode decides which kinds apply: a remote server reads a header, and a stdio server reads
// the process environment. A pair that no harness can express fails here, because a silent drop
// would hand the engineer an unauthenticated server (P35).
function validateAuth(file: string, ns: string, mode: ProxyConfig["mode"], auth: unknown): void {
  const scheme: unknown = isRecord(auth) ? auth.scheme : undefined;
  const source: unknown = isRecord(auth) ? auth.source : undefined;
  if (!isRecord(scheme) || !isRecord(source)) fail(file, ns, "auth requires both scheme and source");
  const kind: unknown = scheme.kind;
  if (typeof kind !== "string" || !SCHEME_KINDS.has(kind))
    fail(file, ns, `auth.scheme.kind must be one of ${[...SCHEME_KINDS].join(", ")}`);
  const from: unknown = source.from;
  if (typeof from !== "string" || !SOURCE_FROM.has(from))
    fail(file, ns, `auth.source.from must be one of ${[...SOURCE_FROM].join(", ")}`);
  if (from === "literal")
    fail(file, ns, "a literal credential source is forbidden — a shared registry must never carry a secret");
  const remote = mode === "remote_http" || mode === "remote_sse";
  if (kind === "env" && remote) {
    fail(
      file,
      ns,
      'auth.scheme.kind "env" needs a stdio mode (stdio_npx or stdio_cmd) — a remote server takes bearer, header, or basic',
    );
  }
  if (!remote && (kind === "bearer" || kind === "header" || kind === "basic")) {
    fail(
      file,
      ns,
      `auth.scheme.kind "${kind}" needs a remote mode (remote_http or remote_sse) — a stdio server takes kind "env" with a map`,
    );
  }
  if (kind === "header") {
    if (typeof scheme.name !== "string" || scheme.name === "")
      fail(file, ns, 'auth.scheme.name is required for kind "header"');
    if (scheme.prefix !== undefined && typeof scheme.prefix !== "string")
      fail(file, ns, "auth.scheme.prefix must be a string");
  }
  if (kind === "basic" && scheme.username !== undefined) {
    fail(
      file,
      ns,
      'auth.scheme.username is not used — put the base64 value of "username:password" in the variable that auth.source.var names',
    );
  }
  if (kind === "env" && !isStringRecord(scheme.map))
    fail(file, ns, 'auth.scheme.map must be a mapping of strings for kind "env"');
  if (from === "env" && (typeof source.var !== "string" || source.var === ""))
    fail(file, ns, 'auth.source.var is required for from "env"');
  if (from === "file" && (typeof source.path !== "string" || source.path === ""))
    fail(file, ns, 'auth.source.path is required for from "file"');
}

export function loadRegistry(text: string, fileName: string): ProxyConfig[] {
  const doc: unknown = parse(text);
  const rawProxies: unknown[] = isRecord(doc) && Array.isArray(doc.proxies) ? doc.proxies : [];
  const seen = new Set<string>();
  const out: ProxyConfig[] = [];
  for (const item of rawProxies) {
    if (!isRecord(item)) fail(fileName, "", "each proxy must be a mapping with namespace and mode");
    const ns = typeof item.namespace === "string" ? item.namespace : "";
    if (ns === "" || /\s/.test(ns)) fail(fileName, ns, "namespace must be non-empty without whitespace");
    if (seen.has(ns)) fail(fileName, ns, "duplicate namespace");
    seen.add(ns);
    for (const key of Object.keys(item)) {
      if (!KNOWN_KEYS.includes(key))
        fail(fileName, ns, `unknown key "${key}" — allowed keys: ${KNOWN_KEYS.join(", ")}`);
    }
    const mode = item.mode;
    if (!isMode(mode)) fail(fileName, ns, `unknown mode "${String(mode)}"`);
    if (item.endpoint !== undefined && typeof item.endpoint !== "string")
      fail(fileName, ns, "endpoint must be a string");
    if (item.command !== undefined && typeof item.command !== "string") fail(fileName, ns, "command must be a string");
    if (item.args !== undefined && !isStringList(item.args)) fail(fileName, ns, "args must be a list of strings");
    if (item.env !== undefined && !isRecord(item.env))
      fail(fileName, ns, `env must be a mapping of \${VAR} expansions`);
    if (mode === "remote_http" || mode === "remote_sse") {
      if (typeof item.endpoint !== "string" || !/^https?:\/\//.test(item.endpoint))
        fail(fileName, ns, "an absolute http(s) endpoint is required");
    }
    if (mode === "stdio_npx" && (typeof item.command !== "string" || !EXACT_VERSION.test(item.command))) {
      fail(
        fileName,
        ns,
        `stdio_npx requires an exact pinned package, for example "@example/mcp@1.4.2" (P31); got "${typeof item.command === "string" ? item.command : ""}"`,
      );
    }
    if (mode === "stdio_cmd" && (typeof item.command !== "string" || item.command === ""))
      fail(fileName, ns, "stdio_cmd requires a command");
    const env: Record<string, string> = {};
    if (isRecord(item.env)) {
      for (const [key, value] of Object.entries(item.env)) {
        if (typeof value !== "string" || !ENV_EXPANSION.test(value))
          fail(
            fileName,
            ns,
            `env.${key} must be a "\${VAR}" expansion, not a literal value — a shared registry must never carry a secret`,
          );
        env[key] = value;
      }
    }
    if (item.auth !== undefined) validateAuth(fileName, ns, mode, item.auth);
    out.push({
      namespace: ns,
      mode,
      ...(typeof item.endpoint === "string" ? { endpoint: item.endpoint } : {}),
      ...(typeof item.command === "string" ? { command: item.command } : {}),
      ...(isStringList(item.args) ? { args: item.args } : {}),
      ...(isRecord(item.env) ? { env } : {}),
      // validateAuth checked the kind, the source, and every field each of them requires.
      ...(item.auth !== undefined ? { auth: item.auth as ProxyConfig["auth"] } : {}),
    });
  }
  return out;
}

export function mergeRegistries(base: ProxyConfig[], team: ProxyConfig[]): ProxyConfig[] {
  const teamNames = new Set(team.map((p) => p.namespace));
  const merged = new Map<string, ProxyConfig>();
  for (const p of base) merged.set(p.namespace, p);
  for (const p of team) merged.set(p.namespace, p);
  return [...base.filter((p) => !teamNames.has(p.namespace)).map((p) => p.namespace), ...team.map((p) => p.namespace)]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((ns) => merged.get(ns))
    .filter((p): p is ProxyConfig => p !== undefined);
}
