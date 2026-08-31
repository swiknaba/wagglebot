import type { Catalog } from "./catalog";
import { findUser, nearMatches } from "./catalog";
import type { Exec } from "./exec";

export type Ask = (question: string) => Promise<string>;

const reject = (catalog: Catalog, value: string): never => {
  const near = nearMatches(catalog, value);
  const hint = near.length > 0 ? ` Near matches: ${near.join(", ")}.` : "";
  throw new Error(`username "${value}" matches no User entity in catalog.yaml.${hint}`);
};

export async function getUsername(exec: Exec, ask: Ask, catalog: Catalog): Promise<string> {
  const stored = await exec("git", ["config", "--global", "wagglebot.username"]);
  const current = stored.stdout.trim();
  if (current !== "") {
    if (findUser(catalog, current) === undefined) reject(catalog, current);
    return current;
  }
  const answer = (await ask("Company Git username (as listed in catalog.yaml): ")).trim();
  if (findUser(catalog, answer) === undefined) reject(catalog, answer);
  await exec("git", ["config", "--global", "wagglebot.username", answer]);
  return answer;
}
