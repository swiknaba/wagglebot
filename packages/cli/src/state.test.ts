import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as stateModule from "./state";
import { loadState, type ManagedState, saveState } from "./state";

test("category reset preserves unrelated state and unselected targets", () => {
  const state: ManagedState = {
    jsonKeys: { settings: ["mcp"] },
    agentFiles: [
      "/home/.claude/agents/a.md",
      "/home/.claude/agents/nested/b.md",
      "/home/.claude/agents-other/c.md",
      "/home/.junie/agents/d.md",
    ],
    skills: { "a/b": ["claude-code", "codex"], "c/d": ["claude-code"] },
  };
  expect(typeof stateModule.clearManagedAgentFiles).toBe("function");
  expect(typeof stateModule.clearManagedSkills).toBe("function");
  stateModule.clearManagedAgentFiles(state, ["/home/.claude/agents"]);
  stateModule.clearManagedSkills(state, ["claude-code"]);
  expect(state).toEqual({
    jsonKeys: { settings: ["mcp"] },
    agentFiles: ["/home/.claude/agents-other/c.md", "/home/.junie/agents/d.md"],
    skills: { "a/b": ["codex"] },
  });
});

test("missing state loads do not share mutable category data", () => {
  const dir = mkdtempSync(join(tmpdir(), "wgl-state-"));
  const first = loadState(join(dir, "first.json"));
  first.agentFiles.push("agent.md");
  first.skills["a/b"] = ["codex"];
  first.jsonKeys.config = ["mcp"];
  expect(loadState(join(dir, "second.json"))).toEqual({ jsonKeys: {}, agentFiles: [], skills: {} });
});

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
