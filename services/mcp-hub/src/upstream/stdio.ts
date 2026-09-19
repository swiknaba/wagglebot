import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ProxyConfig } from "@wagglebot/contracts";
import { explicitChildEnv } from "../credentials";
import { McpUpstreamClient, type UpstreamClient } from "./types";

const EXACT_PACKAGE_VERSION =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function npxCommand(packageName: string, args: string[]): { command: string; args: string[] } {
  if (!EXACT_PACKAGE_VERSION.test(packageName)) throw new Error("stdio_npx requires an exact package version");
  return { command: "npx", args: ["-y", packageName, ...args] };
}

export function buildStdioOptions(proxy: ProxyConfig, env: Record<string, string | undefined>): StdioServerParameters {
  if (proxy.command === undefined) throw new Error("stdio upstream requires a command");
  const childEnv = explicitChildEnv(proxy, env);
  if (proxy.mode === "stdio_npx") {
    const npx = npxCommand(proxy.command, proxy.args ?? []);
    return { ...npx, env: childEnv, cwd: "/tmp", stderr: "ignore" };
  }
  return { command: proxy.command, args: proxy.args ?? [], env: childEnv, cwd: "/tmp", stderr: "ignore" };
}

export async function requireExecutable(command: string): Promise<void> {
  if (!(await Bun.file(command).exists())) throw new Error("stdio executable not found");
}

export function createStdioClient(proxy: ProxyConfig, env: Record<string, string | undefined>): UpstreamClient {
  const parameters = buildStdioOptions(proxy, env);
  const client = new McpUpstreamClient(new StdioClientTransport(parameters));
  return {
    async initialize(signal: AbortSignal): Promise<void> {
      if (proxy.mode === "stdio_cmd" && parameters.command.startsWith("/")) await requireExecutable(parameters.command);
      await client.initialize(signal);
    },
    listTools(signal: AbortSignal) {
      return client.listTools(signal);
    },
    callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
      return client.callTool(name, args, signal);
    },
    close() {
      return client.close();
    },
  };
}
