import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LocalBrain, LocalMemoryProposal, LocalMemoryProposalInput } from "@wagglebot/local-brain";
import { z } from "zod";

export const TOOL_NAMES = [
  "local_memory_search",
  "brain_memory_propose",
  "brain_memory_save",
  "codegraph_explore",
  "git_history",
  "git_why",
  "local_brain_status",
] as const;

type Args = Record<string, unknown>;
type InvokeResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type InvokableServer = McpServer & { invoke(name: string, args: unknown): Promise<InvokeResult> };
const projectPath = z.string().refine((value) => value.startsWith("/"), "absolute projectPath is required");
const evidence = z
  .object({
    kind: z.enum(["file", "commit", "adr", "issue", "test", "maintainer_confirmation"]),
    ref: z.string().min(1),
  })
  .strict();
const section = z.enum(["Architecture", "Conventions", "Commands", "Decisions", "Warnings", "Learnings"]);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePath = z
  .string()
  .min(1)
  .superRefine((path, context) => {
    const segments = path.split("/");
    if (path.includes("\0")) context.addIssue({ code: "custom", message: "path must not contain NUL" });
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path)) {
      context.addIssue({ code: "custom", message: "path must be repository-relative" });
    }
    if (path.includes("\\")) context.addIssue({ code: "custom", message: "path must use POSIX separators" });
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      context.addIssue({ code: "custom", message: "path must be normalized" });
    }
    if (segments.some((segment) => /^\.env/iu.test(segment))) {
      context.addIssue({ code: "custom", message: "path must not name an environment file" });
    }
    if (segments.some((segment) => /\.(pem|key)$/iu.test(segment))) {
      context.addIssue({ code: "custom", message: "path must not name a key file" });
    }
    if (segments.some((segment) => /^(credentials|secrets)$/iu.test(segment))) {
      context.addIssue({ code: "custom", message: "path must not use a secret directory" });
    }
  });
const conceptPath = relativePath.refine((path) => {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return path.startsWith(".agents/memory/") && path.endsWith(".md") && basename !== "index.md" && basename !== "log.md";
}, "path must name an OKF concept below .agents/memory");
const indexPath = relativePath.refine((path) => {
  return path.startsWith(".agents/memory/") && (path.endsWith("/index.md") || path === ".agents/memory/index.md");
}, "path must name a generated index below .agents/memory");
const replacement = z.object({ path: conceptPath, contentHash: sha256 }).strict();
const proposal = z
  .object({
    proposalId: sha256,
    baseBundleHash: sha256,
    path: conceptPath,
    section,
    title: z.string(),
    summary: z.string(),
    evidence: z.array(evidence),
    replace: replacement.optional(),
    action: z.enum(["add", "replace", "no_change", "needs_resolution"]),
    content: z.string(),
    indexChanges: z.array(z.object({ path: indexPath, content: z.string() }).strict()),
    patch: z.string(),
    warnings: z.array(z.string()),
  })
  .strict();

const ok = (value: unknown): InvokeResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(typeof value === "object" && value !== null ? { structuredContent: value as Record<string, unknown> } : {}),
});
const fail = (error: unknown): InvokeResult => ({
  isError: true,
  content: [{ type: "text", text: error instanceof Error ? error.message : "local brain operation failed" }],
});

export const createLowLevelServer = (brain: LocalBrain): InvokableServer => {
  const server = new McpServer({ name: "wagglebot-local-brain", version: "0.0.0" }) as InvokableServer;
  const handlers = new Map<string, (args: Args) => Promise<InvokeResult>>();
  const schemas = new Map<string, z.ZodObject<z.ZodRawShape>>();
  const register = (name: string, schema: z.ZodRawShape, handler: (args: Args) => Promise<unknown>): void => {
    const validator = z.object(schema).strict();
    server.registerTool(name, { inputSchema: schema }, async (args) => {
      try {
        return ok(await handler(args));
      } catch (error) {
        return fail(error);
      }
    });
    schemas.set(name, validator);
    handlers.set(name, async (args) => {
      const parsed = validator.safeParse(args);
      if (!parsed.success) return fail(new Error(parsed.error.issues[0]?.message ?? "invalid local brain input"));
      try {
        return ok(await handler(parsed.data));
      } catch (error) {
        return fail(error);
      }
    });
  };

  register(
    "local_memory_search",
    {
      projectPath,
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async (args) => {
      const input = args as { projectPath: string; query: string; limit?: number };
      return {
        schemaVersion: 1,
        ...(await brain.memory.search({
          projectRoot: input.projectPath,
          query: input.query,
          limit: input.limit ?? 10,
        })),
      };
    },
  );
  register(
    "brain_memory_propose",
    {
      projectPath,
      section,
      title: z.string().min(1).max(80),
      summary: z.string().min(1).max(1000),
      evidence: z.array(evidence).min(1).max(20),
      replace: replacement.optional(),
    },
    async (args) => {
      const input = args as Omit<LocalMemoryProposalInput, "projectRoot"> & { projectPath: string };
      return {
        schemaVersion: 1,
        proposal: await brain.memory.propose({ ...input, projectRoot: input.projectPath }),
      };
    },
  );
  register("brain_memory_save", { projectPath, proposal }, async (args) => {
    const input = args as { projectPath: string; proposal: LocalMemoryProposal };
    return {
      schemaVersion: 1,
      ...(await brain.memory.save({ projectRoot: input.projectPath, proposal: input.proposal })),
    };
  });
  register(
    "codegraph_explore",
    {
      projectPath,
      query: z.string().min(1).max(500),
      maxNodes: z.number().int().min(1).max(100).optional(),
      includeCode: z.boolean().optional(),
    },
    async (args) => {
      const input = args as { projectPath: string; query: string; maxNodes?: number; includeCode?: boolean };
      if (!("explore" in brain.code)) throw new Error("CodeGraph exploration is unavailable");
      return {
        schemaVersion: 1,
        result: await brain.code.explore({
          projectRoot: input.projectPath,
          query: input.query,
          maxNodes: input.maxNodes ?? 25,
          includeCode: input.includeCode ?? false,
        }),
      };
    },
  );
  register(
    "git_history",
    { projectPath, path: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    async (args) => {
      const input = args as { projectPath: string; path?: string; limit?: number };
      if (!("history" in brain.git)) throw new Error("Git history is unavailable");
      return {
        schemaVersion: 1,
        ...(await brain.git.history({
          projectRoot: input.projectPath,
          path: input.path,
          limit: input.limit ?? 20,
        })),
      };
    },
  );
  register(
    "git_why",
    {
      projectPath,
      path: z.string().min(1),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
      query: z.string().max(2000).optional(),
      maxCommits: z.number().int().min(1).max(200).optional(),
    },
    async (args) => {
      const input = args as {
        projectPath: string;
        path: string;
        startLine?: number;
        endLine?: number;
        query?: string;
        maxCommits?: number;
      };
      if (!("why" in brain.git)) throw new Error("Git explanation is unavailable");
      const { projectPath: projectRoot, ...whyInput } = input;
      return {
        schemaVersion: 1,
        result: await brain.git.why({ ...whyInput, projectRoot }),
      };
    },
  );
  register("local_brain_status", { projectPath }, async (args) => ({
    schemaVersion: 1,
    status: await brain.status((args as { projectPath: string }).projectPath),
  }));

  server.invoke = async (name, args) => {
    const handler = handlers.get(name);
    return handler === undefined ? fail(new Error("unknown local brain tool")) : handler(args as Args);
  };
  return server;
};
