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

// Removes every // and /* */ comment from JSON text. A marker inside a string literal is data,
// so the scan tracks the quote state and the backslash escape.
const stripJsonComments = (text: string): string => {
  let out = "";
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
    } else if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
};

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// True when the text parses only after a comment strip. Gemini CLI accepts comments in
// settings.json, and a rewrite would drop them, so the caller skips such a file (F22). Corrupt
// text fails both parses and reports false, which keeps it on the failure path.
export function hasJsonComments(text: string): boolean {
  return !parses(text) && parses(stripJsonComments(text));
}

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

// Merges hook fragment entries into a settings object. Owns only array elements whose command
// contains "wagglebot:". A foreign element keeps its position. An owned element is replaced in
// place by the next fragment entry. A fragment entry without a slot is appended. An owned
// element without a fragment entry left is stale and dropped (F22).
export function mergeHooks(
  existingText: string,
  fragment: { hooks: Record<string, unknown[]> },
): { next: string; changed: boolean } {
  const doc = parseObject(existingText);
  const hooks = isObject(doc.hooks) ? { ...(doc.hooks as JsonObject) } : {};
  for (const [event, fragmentEntries] of Object.entries(fragment.hooks)) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const pending = [...fragmentEntries];
    const merged: unknown[] = [];
    for (const element of current) {
      if (!carriesMarker(element)) {
        merged.push(element);
        continue;
      }
      const replacement = pending.shift();
      if (replacement !== undefined) merged.push(replacement);
    }
    merged.push(...pending);
    hooks[event] = merged;
  }
  doc.hooks = hooks;
  const next = print(doc);
  return { next, changed: next !== normalized(existingText) };
}
