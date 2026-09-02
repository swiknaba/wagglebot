import { expect, test } from "bun:test";
import { BLOCK_BEGIN, BLOCK_END, renderManagedBlock } from "./managed-block";

const block = (body: string) => `${BLOCK_BEGIN}\n${body}\n${BLOCK_END}`;

test("appends the block to a file with no markers", () => {
  const { next, changed } = renderManagedBlock("# Mine\n", "RULES v1");
  expect(changed).toBe(true);
  expect(next).toBe(`# Mine\n\n${block("RULES v1")}\n`);
});

test("replaces only the block and preserves surrounding content", () => {
  const existing = `# Mine\n\n${block("RULES v1")}\n\n## Also mine\n`;
  const { next, changed } = renderManagedBlock(existing, "RULES v2");
  expect(changed).toBe(true);
  expect(next).toBe(`# Mine\n\n${block("RULES v2")}\n\n## Also mine\n`);
});

test("is idempotent", () => {
  const existing = `intro\n\n${block("RULES v1")}\n`;
  expect(renderManagedBlock(existing, "RULES v1")).toEqual({ next: existing, changed: false });
});

test("a lone begin marker throws", () => {
  expect(() => renderManagedBlock(`${BLOCK_BEGIN}\nx`, "y")).toThrow("end marker");
});

test("hash style uses shell comment markers", () => {
  const { next } = renderManagedBlock("export A=1\n", "export B=2", "hash");
  expect(next).toBe("export A=1\n# wagglebot:begin\nexport B=2\n# wagglebot:end\n");
  expect(renderManagedBlock(next, "export B=2", "hash").changed).toBe(false);
});

test("an html append onto a line without a trailing newline still gets a blank line", () => {
  const { next } = renderManagedBlock("text", "RULES v1");
  expect(next).toContain("text\n\n<!-- wagglebot:begin -->");
});
