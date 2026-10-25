import { expect, test } from "bun:test";
import { explicitChildEnv, resolveCredential } from "./credentials";

test("resolves only named environment and file credentials", async () => {
  expect(
    (
      await resolveCredential(
        { from: "env", var: "TOKEN" },
        { registryOrigin: "remote", env: { TOKEN: "secret", OTHER: "no" }, readFile: async () => "" },
      )
    )?.value,
  ).toBe("secret");
  expect(
    (
      await resolveCredential(
        { from: "file", path: "/tmp/token" },
        { registryOrigin: "local", env: {}, readFile: async () => "secret\n" },
      )
    )?.value,
  ).toBe("secret");
  expect(
    await resolveCredential(
      { from: "env", var: "MISSING" },
      { registryOrigin: "remote", env: {}, readFile: async () => "" },
    ),
  ).toBeNull();
});

test("passes the fixed telemetry-off setting to an upstream child", () => {
  expect(
    explicitChildEnv(
      {
        namespace: "project-brain",
        mode: "stdio_cmd",
        command: "wagglebot-context-engine",
        env: { CODEGRAPH_TELEMETRY: "0" },
      },
      {},
    ),
  ).toEqual({ CODEGRAPH_TELEMETRY: "0" });
});
