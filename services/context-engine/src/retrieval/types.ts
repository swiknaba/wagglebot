import type { ContextFreshness, ContextItem, ContextPacket, ProviderFailure } from "@wagglebot/contracts";

export type ContextSource = ContextItem["source"];

export type RetrievalCandidate = Omit<ContextItem, "excerpt" | "channelRanks" | "fusedScore"> & {
  content: string;
  contentHash: string;
  identityKey?: string;
  exactMatch: boolean;
  updatedAt?: string;
  supersedes?: string;
  supersededBy?: string;
  channels: Array<{ name: string; rank: number; weight: number }>;
};

export type RankedCandidate = RetrievalCandidate & { fusedScore: number };
export type CodeGraphMetadata = {
  state: "missing" | "ready" | "pending" | "error";
  pendingFiles: string[];
};
export type RetrievalResult = {
  candidates: RetrievalCandidate[];
  degraded: ProviderFailure[];
  timings: Record<string, number>;
  codeGraph?: CodeGraphMetadata;
};
export type ContextPacketBase = Omit<
  ContextPacket,
  "items" | "conflicts" | "degraded" | "omitted" | "estimatedTokens"
> & {
  freshness: ContextFreshness;
};
