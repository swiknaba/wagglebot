import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "./state";

test("missing file loads as empty state; save then load round-trips", () => {
  const file = join(mkdtempSync(join(tmpdir(), "wgl-")), "managed.json");
  expect(loadState(file)).toEqual({ jsonKeys: {}, agentFiles: [], skills: {} });
  const state = {
    jsonKeys: { "/x/settings.json": ["mcpServers/example"] },
    agentFiles: ["/x/a.md"],
    skills: {},
  };
  saveState(file, state);
  expect(loadState(file)).toEqual(state);
});

test("skills default to an empty record and round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "wgl-state-"));
  const file = join(dir, "managed.json");
  expect(loadState(file).skills).toEqual({});
  saveState(file, { jsonKeys: {}, agentFiles: [], skills: { "a/b@v1": ["claude-code"] } });
  expect(loadState(file).skills).toEqual({ "a/b@v1": ["claude-code"] });
});
