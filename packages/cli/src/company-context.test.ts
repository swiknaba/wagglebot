import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCompanyContext } from "./company-context";
import { createReporter } from "./report";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "wgl-context-"));
  writeFileSync(join(root, "wagglebot.yaml"), "version: 1\nkind: company\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { wagglebot: "1.4.2" } }));
  mkdirSync(join(root, "company"));
  return root;
};
const catalog =
  "kind: Group\nmetadata: { name: a }\nspec: { members: [alice] }\n---\nkind: Group\nmetadata: { name: z }\n---\nkind: User\nmetadata: { name: alice }\nspec: { memberOf: [z] }\n";
const resolve = async (root: string, username = "alice") => {
  const lines: string[] = [];
  const reporter = createReporter((line) => lines.push(line), false);
  const context = await resolveCompanyContext({
    root,
    reporter,
    exec: async () => ({ code: 0, stdout: username, stderr: "" }),
    ask: async () => "alice",
  });
  return { context, reporter, lines };
};

test("no catalog selects only company and warns", async () => {
  const root = fixture();
  mkdirSync(join(root, "teams/a"), { recursive: true });
  const { context, reporter, lines } = await resolve(root);
  expect(context.layers.map((layer) => layer.name)).toEqual(["company"]);
  expect(context.catalogFailed).toBe(false);
  expect(reporter.failed()).toBe(false);
  expect(lines.join("\n")).toContain("warning");
});

test("unknown username selects only company and warns", async () => {
  const root = fixture();
  writeFileSync(join(root, "company/catalog.yaml"), catalog);
  const { context, lines } = await resolve(root, "ghost");
  expect(context.layers.map((layer) => layer.name)).toEqual(["company"]);
  expect(context.teams).toEqual([]);
  expect(context.catalogFailed).toBe(false);
  expect(lines.join("\n")).toContain("ghost");
  expect(lines.join("\n")).toContain("warning");
});

test("known user receives all memberships in company then directory order", async () => {
  const root = fixture();
  writeFileSync(join(root, "company/catalog.yaml"), catalog);
  for (const team of ["z", "a"]) mkdirSync(join(root, "teams", team), { recursive: true });
  const { context } = await resolve(root);
  expect(context.teams).toEqual(["a", "z"]);
  expect(context.layers.map((layer) => layer.name)).toEqual(["company", "a", "z"]);
});

for (const invalid of ["kind: User\nmetadata: { name: alice }\nspec: { memberOf: [missing] }", "kind: ["]) {
  test(`invalid catalog falls back to company: ${invalid}`, async () => {
    const root = fixture();
    writeFileSync(join(root, "company/catalog.yaml"), invalid);
    const { context, reporter } = await resolve(root);
    expect(context.layers.map((layer) => layer.name)).toEqual(["company"]);
    expect(context.catalogFailed).toBe(true);
    expect(reporter.counts().failed).toBe(1);
  });
}

test("a team directory absent from the catalog fails with company fallback", async () => {
  const root = fixture();
  writeFileSync(join(root, "company/catalog.yaml"), catalog);
  mkdirSync(join(root, "teams/missing"), { recursive: true });
  const { context, reporter } = await resolve(root);
  expect(context.layers.map((layer) => layer.name)).toEqual(["company"]);
  expect(context.catalogFailed).toBe(true);
  expect(reporter.counts().failed).toBe(1);
});
