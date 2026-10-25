import { parseArgs } from "node:util";
import {
  FullGitShaSchema,
  PublicationRequestSchema,
  PublicationResponseSchema,
  RelativePathSchema,
  SharedScopeSchema,
} from "@wagglebot/contracts";
import { chunkKnowledgeDocument, parseKnowledgeDocument, sourceKey } from "@wagglebot/knowledge";
import { isCompanyRoot } from "../company";
import { type Exec, realExec } from "../exec";
import { createMemoryAdminClient, MemoryClientError, type MemoryFetch } from "../memory-http";

const usage =
  "Usage: wagglebot knowledge publish <path> --repository <identity> --operation-key <key> [--revision <ref>] [--remove --scope <scope> --owner <owner>]";

export async function runKnowledgePublish(input: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  exec?: Exec;
  fetch?: MemoryFetch;
  write(line: string): void;
}): Promise<number> {
  let path: string;
  let repository: string;
  let operationKey: string;
  let ref: string;
  let remove: boolean;
  let removalScope: ReturnType<typeof SharedScopeSchema.parse> | undefined;
  let owner: string | undefined;
  try {
    const [command, ...args] = input.args;
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        repository: { type: "string" },
        "operation-key": { type: "string" },
        revision: { type: "string" },
        remove: { type: "boolean" },
        scope: { type: "string" },
        owner: { type: "string" },
      },
    });
    if (command !== "publish" || positionals.length !== 1) throw new Error();
    path = RelativePathSchema.parse(positionals[0]);
    repository = PublicationRequestSchema.shape.repository.parse(values.repository);
    operationKey = PublicationRequestSchema.shape.operationKey.parse(values["operation-key"]);
    ref = values.revision ?? "HEAD";
    remove = values.remove ?? false;
    if (remove) {
      const match = /^(system|domain):([a-z0-9][a-z0-9._-]*)$/u.exec(values.scope ?? "");
      removalScope = SharedScopeSchema.parse(
        values.scope === "org" ? { kind: "org" } : { kind: match?.[1], name: match?.[2] },
      );
      owner = PublicationRequestSchema.shape.owner.parse(values.owner);
    } else if (values.scope !== undefined || values.owner !== undefined) throw new Error();
  } catch {
    input.write(usage);
    return 2;
  }
  try {
    if (!isCompanyRoot(input.cwd)) throw new Error();
    const client = createMemoryAdminClient(input);
    const environment = { ...process.env, ...input.env };
    for (const name of Object.keys(environment)) if (name.startsWith("GIT_")) delete environment[name];
    const exec = input.exec ?? realExec;
    let checkoutRoot = input.cwd;
    const git = async (...args: string[]) => {
      const result = await exec(
        "git",
        ["--no-optional-locks", "--no-replace-objects", "--literal-pathspecs", ...args],
        {
          cwd: checkoutRoot,
          env: environment,
        },
      );
      if (result.code !== 0) throw new Error();
      return result.stdout;
    };
    const prefix = (await git("rev-parse", "--show-prefix")).replace(/\n$/u, "");
    path = RelativePathSchema.parse(`${prefix}${path}`);
    checkoutRoot = (await git("rev-parse", "--show-toplevel")).replace(/\n$/u, "");
    const revision = FullGitShaSchema.parse(
      (await git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`)).trim(),
    );
    const tree = await git("ls-tree", "-z", revision, "--", path);
    let scope: ReturnType<typeof SharedScopeSchema.parse>;
    let chunks: unknown[];
    if (remove) {
      if (tree !== "" || !removalScope || !owner) throw new Error();
      scope = removalScope;
      chunks = [];
    } else {
      if (!/^100(?:644|755) blob [a-f0-9]{40}\t[^\0]+\0$/u.test(tree)) throw new Error();
      const text = await git("show", `${revision}:${path}`);
      if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error();
      const document = parseKnowledgeDocument(text);
      scope = document.metadata.scope;
      owner = document.metadata.owner;
      const scopeString = scope.kind === "org" ? "org" : `${scope.kind}:${scope.name}`;
      const key = sourceKey(repository, path, scopeString);
      const capturedAt = new Date((await git("show", "-s", "--format=%cI", revision)).trim()).toISOString();
      chunks = chunkKnowledgeDocument(document.body, key).map((chunk) => ({
        chunkKey: chunk.chunkKey,
        heading: chunk.heading || document.metadata.title,
        kind: document.metadata.kind,
        title: document.metadata.title,
        content: chunk.content,
        confidence: document.metadata.confidence,
        wake: document.metadata.wake,
        ...(document.metadata.reviewAfter === undefined ? {} : { reviewAfter: document.metadata.reviewAfter }),
        provenance: [{ sourceType: "git", actor: owner, repository, path, commitSha: revision, capturedAt }],
      }));
    }
    const request = PublicationRequestSchema.parse({
      schemaVersion: 1,
      operationKey,
      revision,
      repository,
      path,
      scope,
      owner,
      chunks,
    });
    const scopeString = scope.kind === "org" ? "org" : `${scope.kind}:${scope.name}`;
    const key = sourceKey(repository, path, scopeString);
    const result = await client.send(
      "PUT",
      `/v1/publications/${encodeURIComponent(key)}`,
      request,
      PublicationResponseSchema,
    );
    input.write(JSON.stringify(result));
    return 0;
  } catch (error) {
    input.write(
      `wagglebot knowledge publish: ${error instanceof MemoryClientError ? error.message : "publication_invalid"}`,
    );
    return 1;
  }
}
