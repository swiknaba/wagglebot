import type { Catalog } from "../../../packages/company-config/src/catalog";
import type { AuthPrincipal as VerifiedAuthPrincipal } from "../../../packages/contracts/src/auth";

export type { VerifiedAuthPrincipal };

export type Principal = {
  username: string;
  issuedAt: Date;
  expiresAt: Date;
  tokenId: string;
  groups: string[];
  orgOwner: boolean;
};

export class PrincipalError extends Error {
  readonly code = "auth_invalid" as const;

  constructor() {
    super("auth_invalid");
    this.name = "PrincipalError";
  }
}

export function resolvePrincipal(
  verifiedAuthPrincipal: VerifiedAuthPrincipal,
  catalog: Catalog,
  now: Date = new Date(),
): Principal {
  const issuedAt = verifiedAuthPrincipal.issuedAt.getTime();
  const expiresAt = verifiedAuthPrincipal.expiresAt.getTime();
  const nowMs = now.getTime();
  if (
    verifiedAuthPrincipal.audience !== "wagglebot-memory" ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(nowMs) ||
    issuedAt >= expiresAt ||
    issuedAt > nowMs ||
    expiresAt <= nowMs
  ) {
    throw new PrincipalError();
  }

  const user = catalog.users.find((candidate) => candidate.name === verifiedAuthPrincipal.username);
  if (user === undefined) throw new PrincipalError();

  return {
    username: user.name,
    issuedAt: new Date(issuedAt),
    expiresAt: new Date(expiresAt),
    tokenId: verifiedAuthPrincipal.tokenId,
    groups: catalog.groups
      .filter((group) => group.members.includes(user.name))
      .map((group) => group.name)
      .sort(),
    orgOwner: user.orgOwner,
  };
}

export type MemoryTokenVerifier = (token: string, audience: "wagglebot-memory") => Promise<VerifiedAuthPrincipal>;
export type CurrentCatalogLoader = () => Promise<Catalog>;

export function createMemoryPrincipalResolver(options: {
  verifyToken: MemoryTokenVerifier;
  loadCatalog: CurrentCatalogLoader;
  clock?: () => Date;
}): (token: string) => Promise<Principal> {
  return async (token) => {
    let verified: VerifiedAuthPrincipal;
    try {
      verified = await options.verifyToken(token, "wagglebot-memory");
    } catch {
      throw new PrincipalError();
    }
    const catalog = await options.loadCatalog();
    return resolvePrincipal(verified, catalog, options.clock?.() ?? new Date());
  };
}
