import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ProxyConfig, type TrustRecord, TrustRecordSchema } from "@wagglebot/contracts";

export class TrustStore {
  private records = new Map<string, TrustRecord>();
  public constructor(private readonly path: string) {}
  public async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("trust records must be a list");
      const records = parsed.map((value) => TrustRecordSchema.parse(value));
      this.records = new Map(records.map((record) => [record.namespace, record]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("invalid trust store");
    }
  }
  public requireApproval(proxy: ProxyConfig): boolean {
    const record = this.records.get(proxy.namespace);
    return record?.fingerprint === fingerprint(proxy);
  }
  public async approve(proxy: ProxyConfig, privilegedKinds: TrustRecord["privilegedKinds"]): Promise<void> {
    const record: TrustRecord = {
      namespace: proxy.namespace,
      fingerprint: fingerprint(proxy),
      privilegedKinds,
      approvedAt: new Date().toISOString(),
    };
    this.records.set(proxy.namespace, record);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify([...this.records.values()], null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}
function fingerprint(proxy: ProxyConfig): string {
  return createHash("sha256")
    .update(`wagglebot:hub-trust:v1\0${canonical(proxy)}`)
    .digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
