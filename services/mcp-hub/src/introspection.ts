import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type HubConfig, type RegistrySnapshot, type ToolCatalog, ToolCatalogSchema } from "@wagglebot/contracts";
import { parse } from "yaml";
import type { DiscoveryCache } from "./discovery/cache";

const MAX_CATALOG_BYTES = 32 * 1024;
const MAX_USAGE_GUIDE_BYTES = 16 * 1024;

type AvailableNamespace = {
  namespace: string;
  status: "ready" | "empty";
  toolCount: number;
  lastSuccessAt: string | null;
  nextRetryAt: string | null;
};

type IntrospectionOptions = {
  cache: DiscoveryCache;
  registry: () => RegistrySnapshot | undefined;
  catalog?: {
    current: () => ToolCatalog | undefined;
    revision: () => string | undefined;
  };
};

type CatalogFamily = ToolCatalog["families"][number];

type ToolCatalogCacheOptions = {
  path: string;
  readFile?: (path: string) => Promise<string>;
};

export class ToolCatalogCache {
  private catalog?: ToolCatalog;
  private catalogRevision?: string;

  public constructor(private readonly options: ToolCatalogCacheOptions) {}

  public current(): ToolCatalog | undefined {
    return this.catalog === undefined ? undefined : structuredClone(this.catalog);
  }

  public revision(): string | undefined {
    return this.catalogRevision;
  }

  public async refresh(): Promise<ToolCatalog> {
    const text = await (this.options.readFile ?? ((path) => readFile(path, "utf8")))(this.options.path);
    const candidate = ToolCatalogSchema.parse(parse(text));
    this.catalog = candidate;
    this.catalogRevision = `catalog_${createHash("sha256").update(JSON.stringify(candidate)).digest("hex")}`;
    return structuredClone(candidate);
  }
}

type CreateIntrospectionOptions = {
  cache: DiscoveryCache;
  registry: () => RegistrySnapshot | undefined;
  config: Pick<HubConfig, "toolCatalogPath">;
  readFile?: (path: string) => Promise<string>;
};

export type IntrospectionRuntime = {
  introspection: Introspection;
  refreshLocalCatalog(): Promise<void>;
};

export async function createIntrospection(options: CreateIntrospectionOptions): Promise<IntrospectionRuntime> {
  if (!options.config.toolCatalogPath)
    return { introspection: new Introspection(options), refreshLocalCatalog: async () => {} };
  const catalog = new ToolCatalogCache({ path: options.config.toolCatalogPath, readFile: options.readFile });
  await catalog.refresh();
  return {
    introspection: new Introspection({
      ...options,
      catalog: { current: () => catalog.current(), revision: () => catalog.revision() },
    }),
    refreshLocalCatalog: async () => {
      await catalog.refresh();
    },
  };
}

function bounded(value: string, maximum: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximum) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maximum) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function matches(namespace: string, pattern: string): boolean {
  return pattern.endsWith("*") ? namespace.startsWith(pattern.slice(0, -1)) : namespace === pattern;
}

function familyNamespaces(family: CatalogFamily, namespaces: readonly string[]): string[] {
  return namespaces.filter((namespace) => family.namespace_patterns.some((pattern) => matches(namespace, pattern)));
}

function catalogFamilies(
  catalog: ToolCatalog,
  namespaces: readonly string[],
): Array<{ family: CatalogFamily; namespaces: string[] }> {
  return catalog.families
    .map((family) => ({ family, namespaces: familyNamespaces(family, namespaces) }))
    .filter((value) => value.namespaces.length > 0);
}

function catalogMarkdown(catalog: ToolCatalog, namespaces: readonly string[]): string {
  const sections = [`# ${catalog.title}`];
  if (catalog.overview) sections.push(catalog.overview);
  if (catalog.platform_context.length > 0) sections.push(`Platform context: ${catalog.platform_context.join("; ")}`);
  if (catalog.operating_principles.length > 0)
    sections.push(`Operating principles: ${catalog.operating_principles.join("; ")}`);
  for (const { family, namespaces: mounted } of catalogFamilies(catalog, namespaces)) {
    const details = [`## ${family.title}`];
    if (family.summary) details.push(family.summary);
    details.push(`Namespaces: ${mounted.join(", ")}`);
    if (family.transport) details.push(`Transport: ${family.transport}`);
    if (family.tool_prefixes.length > 0) details.push(`Tool prefixes: ${family.tool_prefixes.join(", ")}`);
    if (family.use_for.length > 0) details.push(`Use for: ${family.use_for.join("; ")}`);
    if (family.start_with.length > 0) details.push(`Start with: ${family.start_with.join("; ")}`);
    if (family.avoid.length > 0) details.push(`Avoid: ${family.avoid.join("; ")}`);
    if (family.domain_notes.length > 0) details.push(`Domain notes: ${family.domain_notes.join("; ")}`);
    if (family.examples.length > 0) details.push(`Examples: ${family.examples.join("; ")}`);
    sections.push(details.join("\n\n"));
  }
  return bounded(sections.join("\n\n"), MAX_CATALOG_BYTES);
}

function score(family: CatalogFamily, task: string, tokens: Set<string>): number {
  const normalized = task.toLowerCase();
  const phraseScore = family.routing_phrases.filter((phrase) => normalized.includes(phrase.toLowerCase())).length * 6;
  const keywordScore = family.routing_keywords.filter((keyword) => tokens.has(keyword.toLowerCase())).length * 2;
  const idScore = tokens.has(family.id.toLowerCase()) ? 3 : 0;
  const titleScore = family.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "" && tokens.has(word)).length;
  return phraseScore + keywordScore + idScore + titleScore;
}

export class Introspection {
  public constructor(private readonly options: IntrospectionOptions) {}

  private readyNamespaces(): string[] {
    return [...this.options.cache.states()]
      .filter(([, state]) => state.status === "ready" || state.status === "empty")
      .map(([namespace]) => namespace)
      .sort((left, right) => left.localeCompare(right));
  }

  private snapshot(): RegistrySnapshot {
    const snapshot = this.options.registry();
    if (!snapshot) throw new Error("hub_namespace_unavailable");
    return snapshot;
  }

  private catalog(): ToolCatalog {
    return this.options.catalog?.current() ?? this.snapshot().toolCatalog;
  }

  private catalogRevision(): string {
    return this.options.catalog?.revision() ?? this.snapshot().revision;
  }

  public listAvailableMcps(): { schemaVersion: 1; namespaces: AvailableNamespace[] } {
    const namespaces = [...this.options.cache.states()]
      .flatMap(([namespace, state]) =>
        state.status === "ready" || state.status === "empty"
          ? [
              {
                namespace,
                status: state.status,
                toolCount: state.toolCount,
                lastSuccessAt: state.lastSuccessAt,
                nextRetryAt: state.nextRetryAt,
              },
            ]
          : [],
      )
      .sort((left, right) => left.namespace.localeCompare(right.namespace));
    return { schemaVersion: 1, namespaces };
  }

  public getToolCatalog(): { schemaVersion: 1; revision: string; markdown: string } {
    return {
      schemaVersion: 1,
      revision: this.catalogRevision(),
      markdown: catalogMarkdown(this.catalog(), this.readyNamespaces()),
    };
  }

  public recommendToolFamilies(task: string): {
    schemaVersion: 1;
    families: Array<{ id: string; title: string; score: number; namespaces: string[] }>;
  } {
    if ([...task].length < 1 || [...task].length > 500) throw new Error("hub_invalid_request");
    const tokens = new Set(
      task
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    const families = catalogFamilies(this.catalog(), this.readyNamespaces())
      .map(({ family, namespaces }) => ({
        id: family.id,
        title: family.title,
        score: score(family, task, tokens),
        namespaces,
      }))
      .filter((family) => family.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    return { schemaVersion: 1, families };
  }

  public getUsageGuide(): { schemaVersion: 1; markdown: string } {
    const families = catalogFamilies(this.catalog(), this.readyNamespaces());
    const ready = families.map(
      ({ family, namespaces }) => `- ${family.title} (${namespaces.map((value) => `\`${value}\``).join(", ")})`,
    );
    return {
      schemaVersion: 1,
      markdown: bounded(
        [
          "Use `search` to find a tool, `get_schema` to inspect its input, then `execute` with validated arguments.",
          "Ready families:",
          ...ready,
        ].join("\n\n"),
        MAX_USAGE_GUIDE_BYTES,
      ),
    };
  }
}
