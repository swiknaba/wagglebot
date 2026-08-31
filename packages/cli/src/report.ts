export type ItemStatus = "installed" | "updated" | "ok" | "skipped" | "failed";
export type Reporter = {
  section(title: string): void;
  item(name: string, status: ItemStatus, detail?: string): void;
  counts(): Record<ItemStatus, number>;
  failed(): boolean;
  summary(): string;
};

const COLORS: Record<ItemStatus, string> = {
  installed: "[32m",
  updated: "[36m",
  ok: "[90m",
  skipped: "[33m",
  failed: "[31m",
};
const RESET = "[0m";
const ORDER: ItemStatus[] = ["installed", "updated", "ok", "skipped", "failed"];

export function createReporter(write: (line: string) => void, color = process.stdout.isTTY === true): Reporter {
  const tally: Record<ItemStatus, number> = { installed: 0, updated: 0, ok: 0, skipped: 0, failed: 0 };
  return {
    section: (title) => write(`== ${title} ==`),
    item: (name, status, detail) => {
      tally[status] += 1;
      const label = color ? `${COLORS[status]}${status}${RESET}` : status;
      write(`  ${label.padEnd(color ? 18 : 9)} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
    },
    counts: () => ({ ...tally }),
    failed: () => tally.failed > 0,
    summary: () => ORDER.map((s) => `${s} ${tally[s]}`).join(", "),
  };
}
