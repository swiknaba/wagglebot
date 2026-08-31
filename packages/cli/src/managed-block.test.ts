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
