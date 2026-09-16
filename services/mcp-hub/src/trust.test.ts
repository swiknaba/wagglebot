import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { TrustStore } from "./trust";

test("trust approval is required again when a proxy changes", async () => {
  const store = new TrustStore(join(mkdtempSync(join("/tmp", "waggle-trust-")), "registry.trust.json"));
  const proxy = { namespace: "x", mode: "stdio_cmd" as const, command: "run" };
  await store.load();
  expect(store.requireApproval(proxy)).toBe(false);
  await store.approve(proxy, ["command"]);
  expect(store.requireApproval(proxy)).toBe(true);
  expect(store.requireApproval({ ...proxy, command: "other" })).toBe(false);
});
