import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helper";

const skillsDir = join(repoRoot, "skills");
const REQUIRED = ["writing-a-custom-agent", "adding-an-mcp-server", "onboarding-a-repository"];

test("every first-party skill has a SKILL.md whose front matter name equals its directory", () => {
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  expect(dirs).toEqual([...REQUIRED].sort());
  for (const dir of dirs) {
    const text = readFileSync(join(skillsDir, dir, "SKILL.md"), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(front, `${dir}/SKILL.md has no front matter`).not.toBeNull();
    expect(front?.[1]).toContain(`name: ${dir}`);
    expect(front?.[1]).toMatch(/\ndescription: .+|^description: .+/m);
  }
});

test("writing-a-custom-agent asks where the agent belongs before any code", () => {
  const text = readFileSync(join(skillsDir, "writing-a-custom-agent", "SKILL.md"), "utf8");
  expect(text).toContain("this repository only, or for the whole team");
});
