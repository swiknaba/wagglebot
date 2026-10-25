import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") {
    result = {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "hub-stdio-fixture", version: "1.0.0" },
    };
  } else if (request.method === "tools/list") {
    result = {
      tools: [{ name: "environment", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    };
  } else if (request.method === "tools/call") {
    result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            home: process.env.HOME,
            user: process.env.USER,
            hubBearer: process.env.MCP_HUB_BEARER_TOKEN,
            authUsername: process.env.MCP_HUB_AUTH_USERNAME,
            upstreamCredential: process.env.UPSTREAM_CREDENTIAL,
          }),
        },
      ],
    };
  } else {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
