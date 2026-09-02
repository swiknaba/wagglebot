type JsonObject = Record<string, unknown>;

const parseObject = (text: string): JsonObject => {
  if (text.trim() === "") return {};
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("managed json: the target file is not a JSON object");
  }
  return raw as JsonObject;
};
const print = (doc: JsonObject): string => `${JSON.stringify(doc, null, 2)}\n`;
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const normalized = (text: string): string => (text.trim() === "" ? "" : print(parseObject(text)));

// Owns child entries under one parent key (for example parentKey = "mcpServers").
// previouslyOwned: child names owned from managed.json ("mcpServers/example" is stored;
// callers pass and receive bare child names — the caller adds the "parentKey/" prefix for state).
export function mergeManagedSection(
  existingText: string,
  parentKey: string,
  entries: Record<string, unknown>,
  previouslyOwned: string[],
): { next: string; changed: boolean; ownedNow: string[] } {
  const doc = parseObject(existingText);
  const parent = isObject(doc[parentKey]) ? { ...(doc[parentKey] as JsonObject) } : {};
  const stale = previouslyOwned.filter((k) => !(k in entries));
  for (const k of stale) delete parent[k];
  for (const [k, v] of Object.entries(entries)) parent[k] = v;
  doc[parentKey] = parent;
  const next = print(doc);
  return { next, changed: next !== normalized(existingText), ownedNow: Object.keys(entries) };
}

// A hook element is wagglebot-owned when any of its nested `hooks[].command` strings contain the
// marker. Foreign fields (matcher, description, etc.) are never inspected — a foreign entry whose
// matcher happens to contain "wagglebot:" must not be mistaken for an owned one (F22).
const carriesMarker = (element: unknown): boolean => {
  if (!isObject(element) || !Array.isArray(element.hooks)) return false;
  return element.hooks.some((h) => isObject(h) && typeof h.command === "string" && h.command.includes("wagglebot:"));
};

// Merges hook fragment entries into a settings object. Owns only array elements whose
// command contains "wagglebot:". Never replaces foreign elements (F22).
export function mergeHooks(
  existingText: string,
  fragment: { hooks: Record<string, unknown[]> },
): { next: string; changed: boolean } {
  const doc = parseObject(existingText);
  const hooks = isObject(doc.hooks) ? { ...(doc.hooks as JsonObject) } : {};
  for (const [event, fragmentEntries] of Object.entries(fragment.hooks)) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const foreign = current.filter((e) => !carriesMarker(e));
    hooks[event] = [...foreign, ...fragmentEntries];
  }
  doc.hooks = hooks;
  const next = print(doc);
  return { next, changed: next !== normalized(existingText) };
}
