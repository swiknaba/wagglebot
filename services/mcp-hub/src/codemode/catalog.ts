import type { DiscoveryState } from "@wagglebot/contracts";

const MAX_DESCRIPTION_LENGTH = 280;
const MAX_SCHEMA_BYTES = 65_536;
const MAX_QUALIFIED_NAME_LENGTH = 120;

export type HubTool = {
  qualifiedName: string;
  namespace: string;
  localName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

function withoutControls(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 0x20 && code !== 0x7f;
    })
    .join("");
}

function sanitizeDescription(value: string): string {
  const firstParagraph = value.split(/\r?\n\s*\r?\n/, 1)[0] ?? "";
  return firstParagraph
    .split(/\r?\n/)
    .filter((line) => !/\b(ignore|disregard|override)\b.*\b(instruction|prompt|rule)s?\b/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH)
    .replace(/\s+/g, " ");
}

function description(value: string): string {
  return withoutControls(sanitizeDescription(value)).replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_LENGTH);
}

function hubTool(namespace: string, value: unknown): HubTool | null {
  if (value === null || typeof value !== "object") return null;
  const tool = value as { name?: unknown; description?: unknown; inputSchema?: unknown };
  if (typeof tool.name !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(tool.name)) return null;
  if (tool.inputSchema === null || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) return null;
  const localName = tool.name.startsWith(`${namespace}_`) ? tool.name.slice(namespace.length + 1) : tool.name;
  const qualifiedName = `${namespace}_${localName}`;
  if (localName === "" || qualifiedName.length > MAX_QUALIFIED_NAME_LENGTH) return null;
  const inputSchema = tool.inputSchema as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(inputSchema)).byteLength > MAX_SCHEMA_BYTES) return null;
  return {
    qualifiedName,
    namespace,
    localName,
    description: description(typeof tool.description === "string" ? tool.description : ""),
    inputSchema: structuredClone(inputSchema),
  };
}

export function buildHubCatalog(states: Map<string, DiscoveryState>): HubTool[] {
  return [...states]
    .flatMap(([namespace, state]) =>
      state.status === "ready" ? state.tools.map((tool) => hubTool(namespace, tool)) : [],
    )
    .filter((tool): tool is HubTool => tool !== null)
    .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
}
