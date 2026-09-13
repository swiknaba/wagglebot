import { readFile } from "node:fs/promises";
import { type ProxyConfig, RegistrySnapshotSchema, type TrustRecord } from "@wagglebot/contracts";
import { TrustStore } from "@wagglebot/mcp-hub";

const privilegedKinds = (proxy: ProxyConfig): TrustRecord["privilegedKinds"] => {
  const kinds = new Set<TrustRecord["privilegedKinds"][number]>();
  if (proxy.mode === "stdio_cmd") kinds.add("command");
  if (proxy.mode === "stdio_npx") kinds.add("package");
  if (proxy.mode === "remote_http" || proxy.mode === "remote_sse") kinds.add("origin");
  if (proxy.auth !== undefined || Object.keys(proxy.env ?? {}).length > 0) kinds.add("credential");
  return [...kinds];
};

export async function runMcpHubApprove(input: {
  namespace: string;
  configPath: string;
  trustPath: string;
  confirm: (question: string) => Promise<string>;
  write: (line: string) => void;
}): Promise<number> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(await readFile(input.configPath, "utf8"));
  } catch {
    input.write("wagglebot mcp-hub: registry configuration could not be read");
    return 1;
  }
  const parsed = RegistrySnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    input.write("wagglebot mcp-hub: registry configuration is invalid");
    return 1;
  }
  const proxy = parsed.data.proxies.find((candidate) => candidate.namespace === input.namespace);
  if (!proxy) {
    input.write(`wagglebot mcp-hub: namespace "${input.namespace}" is not in the registry`);
    return 1;
  }
  const kinds = privilegedKinds(proxy);
  input.write(`Approve ${proxy.namespace}: ${kinds.length === 0 ? "no privileged fields" : kinds.join(", ")}`);
  if ((await input.confirm("Type approve to continue: ")).trim() !== "approve") {
    input.write("wagglebot mcp-hub: approval cancelled");
    return 1;
  }
  const store = new TrustStore(input.trustPath);
  await store.load();
  await store.approve(proxy, kinds);
  input.write(`wagglebot mcp-hub: approved ${proxy.namespace}`);
  return 0;
}
