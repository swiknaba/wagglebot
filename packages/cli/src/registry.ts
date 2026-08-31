import { parse } from "yaml";

export type AuthScheme =
  | { kind: "none" }
  | { kind: "bearer" }
  | { kind: "header"; name: string; prefix?: string }
  | { kind: "basic"; username: string }
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

type RawProxy = {
  namespace?: string;
  mode?: string;
  endpoint?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  auth?: { scheme: AuthScheme; source: CredentialSource };
};

const MODES = new Set(["remote_http", "remote_sse", "stdio_npx", "stdio_cmd"]);
const EXACT_VERSION = /@\d+\.\d+\.\d+([-+][\w.-]+)?$/;

const fail = (file: string, ns: string, message: string): never => {
  throw new Error(`${file}: proxy "${ns}": ${message}`);
};

export function loadRegistry(text: string, fileName: string): ProxyConfig[] {
  const doc: unknown = parse(text);
  const rawProxies =
    typeof doc === "object" && doc !== null && Array.isArray((doc as { proxies?: unknown }).proxies)
      ? ((doc as { proxies: unknown[] }).proxies as RawProxy[])
      : [];
  const seen = new Set<string>();
  for (const p of rawProxies) {
    const ns = p.namespace ?? "";
    if (ns === "" || /\s/.test(ns)) fail(fileName, ns, "namespace must be non-empty without whitespace");
    if (seen.has(ns)) fail(fileName, ns, "duplicate namespace");
    seen.add(ns);
    const mode = p.mode ?? "";
    if (!MODES.has(mode)) fail(fileName, ns, `unknown mode "${mode}"`);
    if (mode === "remote_http" || mode === "remote_sse") {
      if (p.endpoint === undefined || !/^https?:\/\//.test(p.endpoint))
        fail(fileName, ns, "an absolute http(s) endpoint is required");
    }
    if (mode === "stdio_npx" && (p.command === undefined || !EXACT_VERSION.test(p.command))) {
      fail(
        fileName,
        ns,
        `stdio_npx requires an exact pinned package, for example "@example/mcp@1.4.2" (P31); got "${p.command ?? ""}"`,
      );
    }
    if (mode === "stdio_cmd" && (p.command === undefined || p.command === ""))
      fail(fileName, ns, "stdio_cmd requires a command");
    if (p.auth?.source.from === "literal")
      fail(fileName, ns, "a literal credential source is forbidden — a shared registry must never carry a secret");
  }
  return rawProxies as ProxyConfig[];
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
