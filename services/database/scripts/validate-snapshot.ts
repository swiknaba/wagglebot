import { type MemorySnapshot, snapshotScanUnits, validateSnapshot } from "../../../packages/memory-storage/src";
import { createSecretScanner } from "../../../packages/secret-scanner/src";
import shippedManifest from "../migration-version.json";

type SnapshotScanner = {
  assertReady(): Promise<void>;
  scanPersistedDTO(value: unknown): Promise<{ count: number }>;
};

export async function validateSnapshotMaterial(
  value: unknown,
  options: {
    manifest: { latest: string; migrations: string[] };
    scanner?: SnapshotScanner;
  },
): Promise<MemorySnapshot> {
  try {
    const snapshot = validateSnapshot(value, options.manifest);
    if (options.scanner) {
      await options.scanner.assertReady();
      for (const unit of snapshotScanUnits(snapshot))
        if ((await options.scanner.scanPersistedDTO(unit)).count !== 0) throw new Error();
    }
    return snapshot;
  } catch {
    throw new Error("snapshot validation failed");
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--scan")) throw new Error();
    const scanner =
      args[0] === "--scan"
        ? createSecretScanner({
            gitleaks: {
              executable: process.env.MEMORY_GITLEAKS_EXECUTABLE ?? "",
              sha256: process.env.MEMORY_GITLEAKS_SHA256 ?? "",
              version: "8.30.1",
            },
          })
        : undefined;
    const bytes = await Bun.stdin.arrayBuffer();
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const snapshot = await validateSnapshotMaterial(raw, { manifest: shippedManifest, scanner });
    process.stdout.write(JSON.stringify(snapshot));
  } catch {
    console.error("snapshot validation failed");
    process.exitCode = 1;
  }
}
