import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuthClient, SshAgentSigner } from "@wagglebot/auth-protocol";
import { createContextBridge, createLocalBrain } from "@wagglebot/local-brain";
import { createContextEngine } from "./engine";
import { identifyProjectWithCompanyCatalog } from "./identity";
import { registerContextBridgeTools } from "./mcp/context-bridge";
import { registerContextTools } from "./mcp/context-tools";
import { createLowLevelServer } from "./mcp/low-level";
import { createSharedMemoryClient } from "./shared/client";

const brain = createLocalBrain({ identity: identifyProjectWithCompanyCatalog });
const server = createLowLevelServer(brain);
const sharedMemoryUrl = process.env.MEMORY_WORKER_URL;
const authUrl = process.env.MCP_HUB_AUTH_URL;
const authUsername = process.env.MCP_HUB_AUTH_USERNAME;
const authPublicKey = process.env.MCP_HUB_AUTH_PUBLIC_KEY_FILE;
const shared =
  sharedMemoryUrl && authUrl && authUsername && authPublicKey
    ? createSharedMemoryClient({
        baseUrl: sharedMemoryUrl,
        tokens: new AuthClient({
          baseUrl: authUrl,
          username: authUsername,
          signer: new SshAgentSigner({ publicKeyPath: authPublicKey }),
        }),
      })
    : undefined;
const contextEngine = createContextEngine(brain, { shared });
registerContextTools(server, contextEngine);
const contextBridge = createContextBridge(brain);
await contextBridge.initialize();
registerContextBridgeTools(server, contextBridge);
const transport = new StdioServerTransport();
let closed = false;
const shutdown = async (): Promise<void> => {
  if (closed) return;
  closed = true;
  await contextEngine.close();
  await server.close();
};
transport.onclose = () => {
  void shutdown();
};
await server.connect(transport);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
