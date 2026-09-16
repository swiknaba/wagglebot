import { expect, test } from "bun:test";
import { scheduleCatalogRefresh } from "./index";

test("refreshes the catalog at the configured interval and tolerates refresh failures", async () => {
  const callbacks: Array<() => Promise<void>> = [];
  const cleared: unknown[] = [];
  let refreshes = 0;
  const stop = scheduleCatalogRefresh(
    {
      async refresh() {
        refreshes += 1;
        if (refreshes === 2) throw new Error("catalog unavailable");
      },
    },
    60,
    {
      every(callback, intervalMs) {
        expect(intervalMs).toBe(60_000);
        callbacks.push(callback);
        return "catalog-refresh";
      },
      clear(timer) {
        cleared.push(timer);
      },
    },
  );

  await callbacks[0]?.();
  await callbacks[0]?.();
  expect(refreshes).toBe(2);
  stop();
  expect(cleared).toEqual(["catalog-refresh"]);
});
