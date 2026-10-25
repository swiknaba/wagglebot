import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TrustStore } from "./trust";

test("trust approval is required again when a proxy changes", async () => {
  await withTrustPath(async (path) => {
    const store = new TrustStore(path);
    const proxy = { namespace: "x", mode: "stdio_cmd" as const, command: "run" };
    await store.load();
    expect(store.requireApproval(proxy)).toBe(false);
    await store.approve(proxy, ["command"]);
    expect(store.requireApproval(proxy)).toBe(true);
    expect(store.requireApproval({ ...proxy, command: "other" })).toBe(false);
  });
});

test("trust store revokes cached approvals when its file is removed", async () => {
  await withTrustPath(async (path) => {
    const store = new TrustStore(path);
    const proxy = { namespace: "x", mode: "stdio_cmd" as const, command: "run" };
    await store.approve(proxy, ["command"]);
    expect(store.requireApproval(proxy)).toBe(true);

    unlinkSync(path);
    await store.load();

    expect(store.requireApproval(proxy)).toBe(false);
  });
});

test("trust store rejects files readable by group or others", async () => {
  await withTrustPath(async (path) => {
    writeFileSync(path, "[]");
    chmodSync(path, 0o640);

    await expect(new TrustStore(path).load()).rejects.toThrow("invalid trust store");
  });
});

test("trust store rejects symbolic links", async () => {
  await withTrustPath(async (path) => {
    const target = `${path}.target`;
    writeFileSync(target, "[]", { mode: 0o600 });
    symlinkSync(target, path);

    await expect(new TrustStore(path).load()).rejects.toThrow("invalid trust store");
  });
});

test("trust store rejects FIFOs without blocking", async () => {
  await withTrustPath(async (path) => {
    const created = spawnSync("mkfifo", [path], { encoding: "utf8" });
    expect(created.status).toBe(0);

    const moduleUrl = new URL("./trust.ts", import.meta.url).href;
    const source = `const { TrustStore } = await import(${JSON.stringify(moduleUrl)}); await new TrustStore(process.argv[1]).load().then(() => process.exit(2), () => process.exit(0));`;
    const result = spawnSync(process.execPath, ["-e", source, path], { encoding: "utf8", timeout: 1_000 });

    expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe("ETIMEDOUT");
    expect(result.status).toBe(0);
  });
});

async function withTrustPath(run: (path: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join("/tmp", "waggle-trust-"));
  try {
    await run(join(directory, "registry.trust.json"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
