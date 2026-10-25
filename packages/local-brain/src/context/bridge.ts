import type { ContextBridgeRevokeResult } from "@wagglebot/contracts";
import {
  type ContextBridgeExportInput,
  ContextBridgeExportInputSchema,
  type ContextBridgeExportResult,
  ContextBridgeExportResultSchema,
  ContextBridgeHandleInputSchema,
  type ContextBridgeImportResult,
  ContextBridgeImportResultSchema,
  ContextBridgeRevokeInputSchema,
  ContextBridgeStatusInputSchema,
  type ContextBridgeStatusResult,
  type ProjectIdentity,
} from "@wagglebot/contracts";
import type { LocalBrain } from "../local-brain";
import { ContextBridgeError, createBridgePacket } from "./packet";
import { resolveProjectRootKey } from "./root-key";
import { ContextVault } from "./vault";

export type ContextBridge = {
  initialize(): Promise<void>;
  export(input: ContextBridgeExportInput): Promise<ContextBridgeExportResult>;
  import(input: {
    handle: string;
    projectPath: string;
    responseFormat?: "structured" | "markdown";
  }): Promise<ContextBridgeImportResult>;
  status(input: { projectPath: string }): Promise<ContextBridgeStatusResult>;
  revoke(input: { handle: string; projectPath: string }): Promise<ContextBridgeRevokeResult>;
};

const safeParse = <T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  input: unknown,
): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new ContextBridgeError("context_invalid");
  return result.data;
};

export const createContextBridge = (
  brain: Pick<LocalBrain, "identify">,
  options: { vault?: ContextVault; now?: () => Date } = {},
): ContextBridge => {
  const vault = options.vault ?? new ContextVault({ now: options.now });
  const now = options.now ?? (() => new Date());

  const identify = async (projectPath: string): Promise<{ rootKey: string; identity: ProjectIdentity }> => {
    try {
      const [{ rootKey }, identity] = await Promise.all([
        resolveProjectRootKey(projectPath),
        brain.identify(projectPath),
      ]);
      return { rootKey, identity };
    } catch {
      throw new ContextBridgeError("context_unavailable");
    }
  };

  return {
    initialize: () => vault.cleanup(),
    async export(raw) {
      const input = safeParse(ContextBridgeExportInputSchema, raw);
      const { rootKey, identity } = await identify(input.projectPath);
      const packet = createBridgePacket(input, identity, rootKey, now());
      const stored = await vault.export(packet);
      return safeParse(ContextBridgeExportResultSchema, {
        schemaVersion: 1,
        handle: stored.handle,
        packetMeta: stored.packetMeta,
        packet,
      });
    },
    async import(raw) {
      const input = safeParse(ContextBridgeHandleInputSchema, raw);
      const { rootKey } = await identify(input.projectPath);
      const imported = await vault.import(input.handle, rootKey);
      return safeParse(ContextBridgeImportResultSchema, {
        schemaVersion: 1,
        importedContext: imported.packet,
        packetMeta: imported.packetMeta,
      });
    },
    async status(raw) {
      const input = safeParse(ContextBridgeStatusInputSchema, raw);
      const { rootKey } = await identify(input.projectPath);
      return vault.status(rootKey);
    },
    async revoke(raw) {
      const input = safeParse(ContextBridgeRevokeInputSchema, raw);
      await identify(input.projectPath);
      return vault.revoke(input.handle);
    },
  };
};
