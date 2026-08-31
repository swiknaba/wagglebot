import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "./state";

test("missing file loads as empty state; save then load round-trips", () => {
  const file = join(mkdtempSync(join(tmpdir(), "wgl-")), "managed.json");
  expect(loadState(file)).toEqual({ jsonKeys: {}, agentFiles: [] });
  const state = { jsonKeys: { "/x/settings.json": ["mcpServers/example"] }, agentFiles: ["/x/a.md"] };
  saveState(file, state);
  expect(loadState(file)).toEqual(state);
});
