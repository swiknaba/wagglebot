import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLocalBrain } from "@wagglebot/local-brain";
import { createLowLevelServer } from "./mcp/low-level";

const brain = createLocalBrain();
const server = createLowLevelServer(brain);
await server.connect(new StdioServerTransport());
process.once("SIGINT", async () => {
  await brain.close();
  process.exit(0);
});
