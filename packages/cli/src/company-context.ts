import { parseAllDocuments } from "yaml";
import { findUser, loadCatalog, teamsOf } from "./catalog";
import { assertTeamDirsKnown, type CompanyRepo, type Layer, loadCompanyRepo } from "./company";
import type { Exec } from "./exec";
import { type Ask, getUsername } from "./identity";
import type { Reporter } from "./report";

export type ResolvedCompanyContext = {
  company: CompanyRepo;
  username: string;
  teams: string[];
  layers: Layer[];
  catalogFailed: boolean;
};

export async function resolveCompanyContext(input: {
  root: string;
  exec: Exec;
  ask: Ask;
  reporter: Reporter;
}): Promise<ResolvedCompanyContext> {
  const company = loadCompanyRepo(input.root);
  const username = await getUsername(input.exec, input.ask);
  const fallback = { company, username, teams: [], layers: [company.company], catalogFailed: false };
  if (company.catalog === undefined) {
    input.reporter.warn("Company catalog: No catalog exists. Only the company layer applies.");
    return fallback;
  }
  let teams: string[];
  try {
    // The catalog reader does not reject YAML parser errors itself.
    for (const document of parseAllDocuments(company.catalog.text)) {
      if (document.errors.length > 0) throw document.errors[0];
    }
    const catalog = loadCatalog(company.catalog.text, company.catalog.path);
    assertTeamDirsKnown(
      company,
      catalog.groups.map((group) => group.name),
    );
    if (findUser(catalog, username) === undefined) {
      input.reporter.warn(`Company catalog: User "${username}" is unknown. Only the company layer applies.`);
      return fallback;
    }
    teams = teamsOf(catalog, username);
  } catch (error) {
    input.reporter.item("Company catalog", "failed", error instanceof Error ? error.message : String(error));
    return { ...fallback, catalogFailed: true };
  }
  const layers = [company.company, ...company.teams.filter((team) => teams.includes(team.name))];
  return { company, username, teams, layers, catalogFailed: false };
}
