export type WagglebotConfig = { companyRepository?: string };

export type PackageMetadata = {
  version: string;
  wagglebot?: { companyRepository?: string };
};

function hostFromRepositoryUrl(input: string): string | undefined {
  try {
    const parsed = new URL(input);
    if (parsed.hostname !== "") return parsed.hostname;
  } catch {}
  const scp = /^(?:[^@/:]+@)?([^/:]+)(?::.*)?$/.exec(input);
  return scp?.[1];
}

export function rejectRepositoryCredentials(input: string): void {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    if (/^https?:/i.test(input.trim()))
      throw new Error("Invalid HTTP repository URL. Remove any embedded credentials.");
    return;
  }
  if (["http:", "https:"].includes(parsed.protocol) && (parsed.username !== "" || parsed.password !== "")) {
    throw new Error("HTTP repository URLs must not contain credentials. Use your existing Git authentication.");
  }
}

export function isReservedExampleUrl(input: string): boolean {
  const host = hostFromRepositoryUrl(input.trim())?.toLowerCase().replace(/\.$/, "");
  return host?.endsWith(".example") ?? false;
}

export function resolveCompanyRepositoryUrl(input: {
  env: NodeJS.ProcessEnv;
  config: WagglebotConfig;
  packageMetadata: PackageMetadata;
}): string {
  const candidates = [
    input.env.WAGGLEBOT_COMPANY_REPOSITORY_URL,
    input.config.companyRepository,
    input.packageMetadata.wagglebot?.companyRepository,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const url = candidate.trim();
    rejectRepositoryCredentials(url);
    if (url !== "" && !isReservedExampleUrl(url)) return url;
  }
  throw new Error('Run "wagglebot connect <git-url>" first.');
}
