import { expect, test } from "bun:test";
import { renderTemplate } from "./template";

test("concatenates base and overlays with blank-line separators", () => {
  expect(renderTemplate("# Base\n", ["## Team A\n", "## Team B"])).toBe("# Base\n\n## Team A\n\n## Team B\n");
});

test("no overlays returns the base normalized", () => {
  expect(renderTemplate("# Base", [])).toBe("# Base\n");
});
