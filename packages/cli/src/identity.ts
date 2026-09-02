import type { Catalog } from "./catalog";
import { findUser, nearMatches } from "./catalog";
import type { Exec } from "./exec";

export type Ask = (question: string) => Promise<string>;

const reject = (catalog: Catalog, value: string, stored: boolean, hint?: { companyRoot: string }): never => {
  const near = nearMatches(catalog, value);
  const lines = [`username "${value}" matches no User entity in the catalog.`];
  if (near.length > 0) lines.push(`Near matches: ${near.join(", ")}.`);
  const where = hint === undefined ? "the company repository" : hint.companyRoot;
  lines.push(
    `To add yourself: add a User entity named "${value}" to teams/<your-team>/catalog.yaml and add "${value}" to the members of that Group in ${where}. Merge the pull request, then run this command again.`,
  );
  if (stored) lines.push("To change the stored name: git config --global --unset wagglebot.username");
  throw new Error(lines.join("\n"));
};

export async function getUsername(
  exec: Exec,
  ask: Ask,
  catalog: Catalog,
  hint?: { companyRoot: string },
): Promise<string> {
  const stored = await exec("git", ["config", "--global", "wagglebot.username"]);
  const current = stored.stdout.trim();
  if (current !== "") {
    if (findUser(catalog, current) === undefined) reject(catalog, current, true, hint);
    return current;
  }
  const answer = (await ask("Company Git username (as listed in the catalog): ")).trim();
  if (findUser(catalog, answer) === undefined) reject(catalog, answer, false, hint);
  await exec("git", ["config", "--global", "wagglebot.username", answer]);
  return answer;
}
