import type { Exec } from "./exec";

export type Ask = (question: string) => Promise<string>;

export async function getUsername(exec: Exec, ask: Ask): Promise<string> {
  const stored = await exec("git", ["config", "--global", "wagglebot.username"]);
  if (stored.code !== 0 && stored.code !== 1) throw new Error("Cannot read wagglebot.username from Git config.");
  const current = stored.stdout.trim();
  if (current !== "") return current;
  const answer = (await ask("Company Git username: ")).trim();
  const saved = await exec("git", ["config", "--global", "wagglebot.username", answer]);
  if (saved.code !== 0) throw new Error("Cannot store wagglebot.username in Git config.");
  return answer;
}
