import { loadCatalog, type ValidatedSourceSnapshot } from "./catalog";

export type RegistrySourceOptions = { companyRoot: string; sourceRevision: string };
export type RefreshResult = { ok: true; snapshot: ValidatedSourceSnapshot } | { ok: false; error: Error };

export class RegistrySource {
  private accepted?: ValidatedSourceSnapshot;
  private refreshing = false;
  public constructor(private readonly options: RegistrySourceOptions) {}

  public current(): ValidatedSourceSnapshot | undefined {
    return this.accepted;
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
      return { ok: true, snapshot };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause : new Error("registry source unavailable") };
    } finally {
      this.refreshing = false;
    }
  }
}
