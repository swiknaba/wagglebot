import { loadCatalog, type ValidatedSourceSnapshot } from "./catalog";

export type RegistrySourceOptions = { companyRoot: string; sourceRevision: string };
export type RefreshResult = { ok: true; snapshot: ValidatedSourceSnapshot } | { ok: false; error: Error };

export class RegistrySource {
  private accepted?: ValidatedSourceSnapshot;
  private degraded = false;
  private refreshing = false;
  public constructor(private readonly options: RegistrySourceOptions) {}

  public current(): ValidatedSourceSnapshot | undefined {
    return this.accepted;
  }

  public isDegraded(): boolean {
    return this.degraded;
  }

  public async load(): Promise<ValidatedSourceSnapshot> {
    const result = await this.refresh();
    if (!result.ok) throw result.error;
    return result.snapshot;
  }

  public async refresh(): Promise<RefreshResult> {
    if (this.refreshing) {
      return this.accepted
        ? { ok: true, snapshot: this.accepted }
        : { ok: false, error: new Error("refresh already in progress") };
    }
    this.refreshing = true;
    try {
      const snapshot = loadCatalog(this.options.companyRoot, this.options.sourceRevision);
      this.accepted = snapshot;
      this.degraded = false;
      return { ok: true, snapshot };
    } catch (cause) {
      this.degraded = true;
      return { ok: false, error: cause instanceof Error ? cause : new Error("registry source unavailable") };
    } finally {
      this.refreshing = false;
    }
  }
}
