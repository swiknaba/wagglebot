import { createHash } from "node:crypto";
import type { SharedScope } from "../../../packages/contracts/src/base";
import type { MemoryProposalRequest } from "../../../packages/contracts/src/memory";

type MemoryKind = MemoryProposalRequest["facts"][number]["kind"];

export function canonicalize(input: { scope: SharedScope; kind: MemoryKind; title: string; content: string }): {
  identityKey: string;
  canonicalKey: string;
  contentHash: string;
} {
  const title = input.title.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
  const scopeString = input.scope.kind === "org" ? "org" : `${input.scope.kind}:${input.scope.name}`;
  const identity = JSON.stringify([scopeString, input.kind, title]);
  const identityKey = `direct:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
  const contentHash = createHash("sha256").update(input.content, "utf8").digest("hex");
  return { identityKey, canonicalKey: `${identityKey}:${contentHash}`, contentHash };
}
