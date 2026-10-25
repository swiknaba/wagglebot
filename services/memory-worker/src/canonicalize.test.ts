import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalize } from "./canonicalize";

test("normalizes title identity with NFC, whitespace collapse, trim, and lowercase", () => {
  const left = canonicalize({
    scope: { kind: "system", name: "payments" },
    kind: "decision",
    title: "  Cafe\u0301   DB ",
    content: "keep it",
  });
  const right = canonicalize({
    scope: { kind: "system", name: "payments" },
    kind: "decision",
    title: "Café DB",
    content: "keep it",
  });
  expect(left).toEqual(right);
});

test("identity and canonical keys include scope, kind, and content digest", () => {
  const base = { kind: "fact" as const, title: "Use PostgreSQL" };
  const system = canonicalize({ ...base, scope: { kind: "system", name: "payments" }, content: "one" });
  expect(canonicalize({ ...base, scope: { kind: "domain", name: "payments" }, content: "one" }).identityKey).not.toBe(
    system.identityKey,
  );
  expect(canonicalize({ ...base, scope: { kind: "system", name: "payments" }, content: "two" }).canonicalKey).not.toBe(
    system.canonicalKey,
  );
  expect(system.identityKey).toMatch(/^direct:[a-f0-9]{64}$/);
  expect(system.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(system.canonicalKey).toBe(`${system.identityKey}:${system.contentHash}`);
  expect(system.identityKey).toBe(
    `direct:${createHash("sha256")
      .update(JSON.stringify(["system:payments", "fact", "use postgresql"]))
      .digest("hex")}`,
  );
  expect(system.contentHash).toBe(createHash("sha256").update("one", "utf8").digest("hex"));
});
