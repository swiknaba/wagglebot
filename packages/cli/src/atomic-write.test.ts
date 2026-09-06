import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";

test("writes content, creates parent directories, and leaves no tmp file behind", () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-"));
  const target = join(root, "nested", "deep", "file.md");
  writeFileAtomic(target, "hello\n");
  expect(readFileSync(target, "utf8")).toBe("hello\n");
  const siblings = readdirSync(join(root, "nested", "deep"));
  expect(siblings).toEqual(["file.md"]);
  expect(siblings.some((name) => name.endsWith(".wagglebot-tmp"))).toBe(false);
});
