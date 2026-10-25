import { parseArgs } from "node:util";
import {
  AdminReindexRequestSchema,
  AdminReindexResponseSchema,
  AdminRescanRequestSchema,
  AdminRescanResponseSchema,
  AdminRunOnceRequestSchema,
  AdminRunOnceResponseSchema,
} from "@wagglebot/contracts";
import { createMemoryAdminClient, MemoryClientError, type MemoryFetch } from "../memory-http";

const usage =
  "Usage: wagglebot memory admin <rescan|reindex|run-once> --operation-key <key> [--profile-id <uuid> | --limit <1..100>]";

export async function runMemoryAdmin(input: {
  args: string[];
  env: NodeJS.ProcessEnv;
  write(line: string): void;
  fetch?: MemoryFetch;
}): Promise<number> {
  const [admin, action, ...args] = input.args;
  let request: unknown;
  try {
    if (admin !== "admin" || !["rescan", "reindex", "run-once"].includes(action ?? "")) throw new Error();
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        "operation-key": { type: "string" },
        ...(action === "reindex" ? { "profile-id": { type: "string" as const } } : {}),
        ...(action === "run-once" ? { limit: { type: "string" as const } } : {}),
      },
    });
    if (positionals.length > 0) throw new Error();
    const base = { schemaVersion: 1, operationKey: values["operation-key"] };
    if (action === "rescan") request = AdminRescanRequestSchema.parse(base);
    else if (action === "reindex")
      request = AdminReindexRequestSchema.parse({
        ...base,
        ...(values["profile-id"] === undefined ? {} : { profileId: values["profile-id"] }),
      });
    else {
      if (values.limit !== undefined && (typeof values.limit !== "string" || !/^\d+$/u.test(values.limit)))
        throw new Error();
      request = AdminRunOnceRequestSchema.parse({
        ...base,
        ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      });
    }
  } catch {
    input.write(usage);
    return 2;
  }
  try {
    const client = createMemoryAdminClient(input);
    const path = `/v1/admin/${action}`;
    const result =
      action === "rescan"
        ? await client.send("POST", path, request, AdminRescanResponseSchema)
        : action === "reindex"
          ? await client.send("POST", path, request, AdminReindexResponseSchema)
          : await client.send("POST", path, request, AdminRunOnceResponseSchema);
    input.write(JSON.stringify(result));
    return 0;
  } catch (error) {
    input.write(`wagglebot memory admin: ${error instanceof MemoryClientError ? error.message : "memory_unavailable"}`);
    return 1;
  }
}
