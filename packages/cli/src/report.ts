export type ItemStatus = "installed" | "updated" | "ok" | "skipped" | "failed";
export type Reporter = {
  section(title: string): void;
  item(name: string, status: ItemStatus, detail?: string): void;
  // A message that needs attention but fails nothing. Not counted.
  warn(message: string): void;
  counts(): Record<ItemStatus, number>;
  failed(): boolean;
  summary(named?: boolean): string;
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
  const names: Record<ItemStatus | "warned", string[]> = {
    installed: [],
    updated: [],
    ok: [],
    skipped: [],
    warned: [],
    failed: [],
  };
  return {
    section: (title) => write(`== ${title} ==`),
    item: (name, status, detail) => {
      tally[status] += 1;
      names[status].push(name);
      const label = color ? `${COLORS[status]}${status}${RESET}` : status;
      write(`  ${label.padEnd(color ? 18 : 9)} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
    },
    warn: (message) => {
      names.warned.push(message);
      write(`  ${color ? `${COLORS.skipped}warning${RESET}` : "warning"}   ${message}`);
    },
    counts: () => ({ ...tally }),
    failed: () => tally.failed > 0,
    summary: (named = false) => {
      if (!named) return ORDER.map((status) => `${status} ${tally[status]}`).join(", ");
      const statuses = ["installed", "ok", "updated", "skipped", "warned", "failed"] as const;
      return statuses
        .map(
          (status) =>
            `${status} ${names[status].length}${names[status].length === 0 ? "" : ` [${names[status].join(", ")}]`}`,
        )
        .join(", ");
    },
  };
}
