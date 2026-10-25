import { randomBytes } from "node:crypto";
import {
  type ContextBridgeExportInput,
  type ContextBridgePacket,
  ContextBridgePacketSchema,
  type ProjectIdentity,
} from "@wagglebot/contracts";
import { scanText } from "@wagglebot/secret-scanner";

export class ContextBridgeError extends Error {
  constructor(
    readonly code:
      | "context_invalid"
      | "context_expired"
      | "context_project_mismatch"
      | "context_owner_mismatch"
      | "context_limit"
      | "context_unavailable",
  ) {
    super(code);
  }
}

const unsafeAbsolutePath = /(?:^|[\s"'(])(?:\/(?:[^\s"')]+)|[A-Za-z]:[\\/][^\s"')]+)/u;
const transcriptShape = /\b(?:user|assistant|system|developer)\s*:/iu;
const hasUnsafeControl = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    );
  });
const hasUnsafeText = (value: string): boolean =>
  hasUnsafeControl(value) || unsafeAbsolutePath.test(value) || transcriptShape.test(value);

const assertSafeValue = (value: unknown): void => {
  if (typeof value === "string") {
    if (hasUnsafeText(value) || scanText(value).count > 0) throw new ContextBridgeError("context_invalid");
  } else if (Array.isArray(value)) {
    for (const item of value) assertSafeValue(item);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (hasUnsafeText(key) || scanText(key).count > 0) throw new ContextBridgeError("context_invalid");
      assertSafeValue(item);
    }
  }
};

export const assertSafeBridgePacket = (packet: ContextBridgePacket): void => {
  assertSafeValue(packet);
  const serialized = JSON.stringify(packet);
  if (scanText(serialized).count > 0) throw new ContextBridgeError("context_invalid");
};

export const createBridgePacket = (
  input: ContextBridgeExportInput,
  project: ProjectIdentity,
  rootKey: string,
  now: Date,
): ContextBridgePacket => {
  const ttlSeconds = input.ttlSeconds ?? 3_600;
  const packet = ContextBridgePacketSchema.safeParse({
    schemaVersion: 1,
    packetId: `cb_pkt_${randomBytes(16).toString("base64url")}`,
    project: {
      rootKey,
      ...(project.component ? { component: project.component } : {}),
      ...(project.system ? { system: project.system } : {}),
      ...(project.branch ? { branch: project.branch } : {}),
      ...(project.head ? { head: project.head } : {}),
    },
    scope: input.scope,
    goal: input.goal,
    decisions: input.decisions,
    openQuestions: input.openQuestions,
    evidence: input.evidence,
    providerState: input.providerState,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
  });
  if (!packet.success) throw new ContextBridgeError("context_invalid");
  assertSafeBridgePacket(packet.data);
  return packet.data;
};

export const contextBridgePacketId = (): string => `cb_pkt_${randomBytes(16).toString("base64url")}`;
