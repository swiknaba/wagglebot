import { expect, test } from "bun:test";
import { createReporter } from "./report";

test("counts items and reports failure", () => {
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  r.section("Skills");
  r.item("obra/superpowers", "installed");
  r.item("x/y", "failed", "clone failed");
  expect(r.counts().installed).toBe(1);
  expect(r.failed()).toBe(true);
  expect(r.summary()).toBe("installed 1, updated 0, ok 0, skipped 0, failed 1");
  expect(lines).toContain("== Skills ==");
  expect(lines.some((l) => l.includes("x/y") && l.includes("clone failed"))).toBe(true);
});

test("warn writes a line with the message and does not change counts", () => {
  const lines: string[] = [];
  const r = createReporter((l) => lines.push(l), false);
  r.item("a", "ok");
  const before = r.counts();
  r.warn("check this");
  expect(lines.some((l) => l.includes("warning") && l.includes("check this"))).toBe(true);
  expect(r.counts()).toEqual(before);
  expect(r.failed()).toBe(false);
});

test("a named summary includes all items and warnings without changing the default summary", () => {
  const reporter = createReporter(() => {}, false);
  reporter.item("Existing failure", "failed");
  reporter.item("Existing item", "ok");
  reporter.warn("Existing warning");
  expect(reporter.summary(true)).toBe(
    "installed 0, ok 1 [Existing item], updated 0, skipped 0, warned 1 [Existing warning], failed 1 [Existing failure]",
  );
  expect(reporter.summary()).toBe("installed 0, updated 0, ok 1, skipped 0, failed 1");
  expect(reporter.counts()).toEqual({ installed: 0, updated: 0, ok: 1, skipped: 0, failed: 1 });
});
