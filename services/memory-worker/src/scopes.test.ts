import { expect, test } from "bun:test";
import { resolvePrincipal } from "./principal";
import { authorizeWrite, confirmProposal, validateSharedScope, validateWake } from "./scopes";

const catalog = {
  domains: [{ name: "payments", owner: "team-payments" }],
  systems: [{ name: "checkout", owner: "team-payments", domain: "payments" }],
  groups: [{ name: "team-payments", members: ["alice"] }],
  users: [
    { name: "alice", memberOf: [], orgOwner: false },
    { name: "bob", memberOf: ["team-payments"], orgOwner: false },
    { name: "owner", memberOf: [], orgOwner: true },
  ],
};
const auth = (username: string) => ({
  username,
  audience: "wagglebot-memory" as const,
  issuedAt: new Date("2026-10-06T09:00:00.000Z"),
  expiresAt: new Date("2026-10-06T09:15:00.000Z"),
  tokenId: "jti_abcdefghijklmnopqrstuvwxyz12",
});
const now = new Date("2026-10-06T09:05:00.000Z");

test("validates known shared scopes and rejects components and unknown names", () => {
  expect(validateSharedScope({ kind: "system", name: "checkout" }, catalog)).toEqual({
    kind: "system",
    name: "checkout",
  });
  expect(() => validateSharedScope({ kind: "component", name: "web" }, catalog)).toThrow(/unknown_scope/);
  expect(() => validateSharedScope({ kind: "system", name: "missing" }, catalog)).toThrow(/unknown_scope/);
});

test("domain write uses owner Group spec.members, not a user's memberOf claim", () => {
  const alice = resolvePrincipal(auth("alice"), catalog, now);
  const bob = resolvePrincipal(auth("bob"), catalog, now);
  expect(() => authorizeWrite({ kind: "domain", name: "payments" }, alice, catalog)).not.toThrow();
  expect(() => authorizeWrite({ kind: "domain", name: "payments" }, bob, catalog)).toThrow(/domain_owner_required/);
  expect(() => authorizeWrite({ kind: "system", name: "checkout" }, bob, catalog)).not.toThrow();
});

test("org writes require the current catalog owner annotation", () => {
  const alice = resolvePrincipal(auth("alice"), catalog, now);
  const owner = resolvePrincipal(auth("owner"), catalog, now);
  expect(() => authorizeWrite({ kind: "org" }, alice, catalog)).toThrow(/org_owner_required/);
  expect(() => authorizeWrite({ kind: "org" }, owner, catalog)).not.toThrow();
});

test("proposal confirmation is by the authenticated user within the session and not in the future", () => {
  const alice = resolvePrincipal(auth("alice"), catalog, now);
  const fact = (confirmedBy: string, confirmedAt: string) => ({
    scope: { kind: "system" as const, name: "checkout" },
    confirmedBy,
    confirmedAt,
  });
  expect(() => confirmProposal(fact("alice", "2026-10-06T09:04:00.000Z"), alice, now)).not.toThrow();
  expect(() => confirmProposal(fact("bob", "2026-10-06T09:04:00.000Z"), alice, now)).toThrow(/confirmation_required/);
  expect(() => confirmProposal(fact("alice", "2026-10-06T08:59:59.999Z"), alice, now)).toThrow(/confirmation_required/);
  expect(() => confirmProposal(fact("alice", "2026-10-06T09:05:00.001Z"), alice, now)).toThrow(/confirmation_required/);
  expect(() =>
    confirmProposal(
      { ...fact("alice", "2026-10-06T09:04:00.000Z"), scope: { kind: "domain", name: "payments" } },
      alice,
      now,
    ),
  ).toThrow(/confirmation_required/);
  expect(() => confirmProposal({ ...fact("alice", "2026-10-06T09:04:00.000Z"), wake: true }, alice, now)).toThrow(
    /confirmation_required/,
  );
  expect(() =>
    confirmProposal(fact("alice", "2026-10-06T09:04:00.000Z"), alice, new Date("2026-10-06T09:15:00.000Z")),
  ).toThrow(/confirmation_required/);
});

test("wake review date is high confidence and limited to the next 366 UTC days", () => {
  expect(() => validateWake({ wake: true, confidence: "high", reviewAfter: "2027-10-08" }, now)).toThrow(
    /memory_invalid/,
  );
  expect(() => validateWake({ wake: true, confidence: "medium", reviewAfter: "2026-10-07" }, now)).toThrow(
    /memory_invalid/,
  );
  expect(() => validateWake({ wake: true, confidence: "high", reviewAfter: "2026-10-05" }, now)).toThrow(
    /memory_invalid/,
  );
  expect(() => validateWake({ wake: true, confidence: "high", reviewAfter: "2027-10-07" }, now)).not.toThrow();
  expect(() => validateWake({ wake: true, confidence: "high", reviewAfter: "2026-10-06" }, now)).not.toThrow();
});
