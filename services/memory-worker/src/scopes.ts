import type { Catalog } from "../../../packages/company-config/src/catalog";
import { type SharedScope, SharedScopeSchema } from "../../../packages/contracts/src/base";
import type { MemoryProposalRequest } from "../../../packages/contracts/src/memory";
import { type Principal, PrincipalError } from "./principal";

type ProposalFact = MemoryProposalRequest["facts"][number];
type MemoryConfidence = ProposalFact["confidence"];

export class MemoryPolicyError extends Error {
  constructor(
    readonly code:
      | "unknown_scope"
      | "domain_owner_required"
      | "org_owner_required"
      | "confirmation_required"
      | "memory_invalid",
  ) {
    super(code);
    this.name = "MemoryPolicyError";
  }
}

export function validateSharedScope(value: unknown, catalog: Catalog): SharedScope {
  const parsed = SharedScopeSchema.safeParse(value);
  if (!parsed.success) throw new MemoryPolicyError("unknown_scope");
  const scope = parsed.data;
  if (scope.kind === "system" && !catalog.systems.some((system) => system.name === scope.name)) {
    throw new MemoryPolicyError("unknown_scope");
  }
  if (scope.kind === "domain" && !catalog.domains.some((domain) => domain.name === scope.name)) {
    throw new MemoryPolicyError("unknown_scope");
  }
  return scope;
}

export function authorizeWrite(scopeValue: unknown, principal: Principal, catalog: Catalog): void {
  const scope = validateSharedScope(scopeValue, catalog);
  const user = catalog.users.find((candidate) => candidate.name === principal.username);
  if (user === undefined) throw new PrincipalError();

  if (scope.kind === "domain") {
    const domain = catalog.domains.find((candidate) => candidate.name === scope.name);
    const ownerGroup = domain && catalog.groups.find((group) => group.name === domain.owner);
    if (!ownerGroup?.members.includes(user.name)) throw new MemoryPolicyError("domain_owner_required");
  } else if (scope.kind === "org" && !user.orgOwner) {
    throw new MemoryPolicyError("org_owner_required");
  }
}

export function confirmProposal(
  fact: Pick<ProposalFact, "confirmedBy" | "confirmedAt"> & {
    scope: { kind: string; name?: string };
    wake?: boolean;
  },
  principal: Principal,
  now: Date,
): void {
  const confirmedAt = Date.parse(fact.confirmedAt);
  const issuedAt = principal.issuedAt.getTime();
  const expiresAt = principal.expiresAt.getTime();
  const nowMs = now.getTime();
  if (
    fact.scope?.kind !== "system" ||
    fact.wake === true ||
    fact.confirmedBy !== principal.username ||
    !Number.isFinite(confirmedAt) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(nowMs) ||
    nowMs < issuedAt ||
    nowMs >= expiresAt ||
    confirmedAt < issuedAt ||
    confirmedAt > expiresAt ||
    confirmedAt > nowMs
  ) {
    throw new MemoryPolicyError("confirmation_required");
  }
}

export function validateWake(
  fact: { wake: boolean; confidence: MemoryConfidence; reviewAfter?: string },
  now: Date,
): void {
  if (!fact.wake) return;
  if (!Number.isFinite(now.getTime())) throw new MemoryPolicyError("memory_invalid");
  if (fact.confidence !== "high" || fact.reviewAfter === undefined) throw new MemoryPolicyError("memory_invalid");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(fact.reviewAfter);
  if (match === null) throw new MemoryPolicyError("memory_invalid");
  const date = new Date(`${fact.reviewAfter}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== fact.reviewAfter) {
    throw new MemoryPolicyError("memory_invalid");
  }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const latest = new Date(today.getTime() + 366 * 24 * 60 * 60 * 1000);
  if (date < today || date > latest) throw new MemoryPolicyError("memory_invalid");
}
