import { createHash } from "node:crypto";

const sha256 = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");

export function sourceKey(repository: string, path: string, scope: string): string {
  return `wglsrc_${sha256([repository, path, scope])}`;
}

export function chunkKey(source: string, headings: string[], occurrence: number, ordinal = 0): string {
  return sha256([source, headings, occurrence, ordinal]);
}

export function publicationIdentity(source: string, chunk: string): string {
  return `publication:${createHash("sha256")
    .update(JSON.stringify([source, chunk]), "utf8")
    .digest("hex")}`;
}

export function publicationKeys(
  source: string,
  chunk: string,
  content: string,
): {
  identityKey: string;
  contentHash: string;
  canonicalKey: string;
} {
  const identityKey = publicationIdentity(source, chunk);
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  return { identityKey, contentHash, canonicalKey: `${identityKey}:${contentHash}` };
}
