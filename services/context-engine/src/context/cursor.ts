import { randomBytes } from "node:crypto";

const MAX_CURSORS = 128;
const MAX_ITEMS = 256;
const TTL_MS = 4 * 60 * 60 * 1_000;
type Entry = { touchedAt: number; items: Map<string, string> };
export type CursorPreparation = {
  cursor: string;
  previous: Map<string, string>;
  candidates: Array<{ id: string; contentHash: string }>;
  reset: boolean;
  omitted: number;
};

export class ContextCursorCache {
  readonly #entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  prepare(cursor: string | undefined, candidates: Array<{ id: string; contentHash: string }>): CursorPreparation {
    const now = this.now();
    for (const [key, entry] of this.#entries) if (now - entry.touchedAt > TTL_MS) this.#entries.delete(key);
    const previous = cursor ? this.#entries.get(cursor) : undefined;
    const reset = cursor !== undefined && previous === undefined;
    if (previous) {
      this.#entries.delete(cursor as string);
      previous.touchedAt = now;
      this.#entries.set(cursor as string, previous);
    }
    const eligible = candidates.filter(({ id, contentHash }) => previous?.items.get(id) !== contentHash);
    return {
      cursor: `ctx_${randomBytes(16).toString("base64url")}`,
      previous: new Map(previous?.items ?? []),
      candidates: eligible,
      reset,
      omitted: candidates.length - eligible.length,
    };
  }

  commit(prepared: CursorPreparation, delivered: Array<{ id: string; contentHash: string }>): void {
    const items = new Map(prepared.previous);
    for (const { id, contentHash } of delivered) {
      items.delete(id);
      items.set(id, contentHash);
    }
    while (items.size > MAX_ITEMS) items.delete(items.keys().next().value as string);
    this.#entries.set(prepared.cursor, { touchedAt: this.now(), items });
    while (this.#entries.size > MAX_CURSORS) this.#entries.delete(this.#entries.keys().next().value as string);
  }

  get size(): number {
    return this.#entries.size;
  }
}
