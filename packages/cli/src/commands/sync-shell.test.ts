import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReporter } from "../report";
import { runSyncShell } from "./sync-shell";

const quiet = () => createReporter(() => {}, false);
const home = () => mkdtempSync(join(tmpdir(), "wgl-shell-"));

test("writes a hash-marker block to .zshenv and leaves a missing .bashrc alone", () => {
  const h = home();
  expect(runSyncShell({ home: h, companyRoot: "/srv/company", reporter: quiet() })).toBe(0);
  const zshenv = readFileSync(join(h, ".zshenv"), "utf8");
  expect(zshenv).toContain("# wagglebot:begin");
  expect(zshenv).toContain('export WAGGLEBOT_COMPANY_REPO="/srv/company"');
  expect(zshenv).toContain("node_modules/wagglebot/templates/shell/wagglebot.sh");
  expect(existsSync(join(h, ".bashrc"))).toBe(false);
});

test("an existing .bashrc gets the block and keeps its content; second run is ok", () => {
  const h = home();
  writeFileSync(join(h, ".bashrc"), "alias ll='ls -l'\n");
  runSyncShell({ home: h, companyRoot: "/srv/company", reporter: quiet() });
  const bashrc = readFileSync(join(h, ".bashrc"), "utf8");
  expect(bashrc.startsWith("alias ll='ls -l'\n")).toBe(true);
  expect(bashrc).toContain("# wagglebot:end");
  const r = createReporter(() => {}, false);
  expect(runSyncShell({ home: h, companyRoot: "/srv/company", reporter: r })).toBe(0);
  expect(r.counts()).toMatchObject({ ok: 2, updated: 0 });
});

test("a moved company repository rewrites the block", () => {
  const h = home();
  runSyncShell({ home: h, companyRoot: "/old", reporter: quiet() });
  const r = createReporter(() => {}, false);
  runSyncShell({ home: h, companyRoot: "/new", reporter: r });
  expect(r.counts().updated).toBe(1);
  expect(readFileSync(join(h, ".zshenv"), "utf8")).not.toContain("/old");
});
