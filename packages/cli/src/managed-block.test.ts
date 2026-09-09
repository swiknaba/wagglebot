import { expect, test } from "bun:test";
import { BLOCK_BEGIN, BLOCK_END, removeManagedBlock, renderManagedBlock } from "./managed-block";

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

test("removeManagedBlock removes the block and the blank line before it", () => {
  const { next, changed } = removeManagedBlock(`# Mine\n\n${block("RULES v1")}\n`);
  expect(changed).toBe(true);
  expect(next).toBe("# Mine\n");
});

test("removeManagedBlock on a file that is only the block returns empty content", () => {
  const { next, changed } = removeManagedBlock(`${block("RULES v1")}\n`);
  expect(changed).toBe(true);
  expect(next).toBe("");
});

test("removeManagedBlock keeps content that comes after the block", () => {
  const { next, changed } = removeManagedBlock(`${block("RULES v1")}\n\n## Also mine\n`);
  expect(changed).toBe(true);
  expect(next).toContain("## Also mine");
});

test("removeManagedBlock on a file with no markers is unchanged", () => {
  const existing = "# Mine\n";
  expect(removeManagedBlock(existing)).toEqual({ next: existing, changed: false });
});

test("removeManagedBlock throws on a lone begin marker", () => {
  expect(() => removeManagedBlock(`${BLOCK_BEGIN}\nx`)).toThrow("end marker");
});
