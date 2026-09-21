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

export function replaceJsonCategory(
  existingText: string,
  key: string,
  value: unknown,
): { next: string; changed: boolean } {
  const doc = parseObject(existingText);
  const next = print({ ...doc, [key]: value });
  return { next, changed: next !== normalized(existingText) };
}

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
  // Object.hasOwn: a namespace such as "constructor" must still count as stale once it is gone.
  const stale = previouslyOwned.filter((k) => !Object.hasOwn(entries, k));
  for (const k of stale) delete parent[k];
  for (const [k, v] of Object.entries(entries)) parent[k] = v;
  doc[parentKey] = parent;
  const next = print(doc);
  return { next, changed: next !== normalized(existingText), ownedNow: Object.keys(entries) };
}

// Only executable command fields establish ownership. Names and matchers can contain foreign markers.
const carriesMarker = (element: unknown): boolean => {
  if (!isObject(element)) return false;
  return (
    [element.command, element.bash, element.powershell].some(
      (command) => typeof command === "string" && command.includes("wagglebot:"),
    ) ||
    (isObject(element.action) && carriesMarker(element.action)) ||
    (Array.isArray(element.hooks) && element.hooks.some(carriesMarker))
  );
};

const mergeHookEntries = (current: unknown[], entries: unknown[]): unknown[] => {
  const pending = [...entries];
  const merged: unknown[] = [];
  for (const element of current) {
    if (!carriesMarker(element)) {
      merged.push(element);
      continue;
    }
    if (isObject(element) && Array.isArray(element.hooks)) {
      const foreign = element.hooks.filter((hook) => !carriesMarker(hook));
      if (foreign.length > 0) merged.push({ ...element, hooks: foreign });
    }
    const replacement = pending.shift();
    if (replacement !== undefined) merged.push(replacement);
  }
  return [...merged, ...pending];
};

export type HookFragment = { version?: number | string; hooks: Record<string, unknown[]> | unknown[] };

// Preserve foreign entries and replace owned entries in place. Kiro uses an array instead of an event map.
export function mergeHooks(existingText: string, fragment: HookFragment): { next: string; changed: boolean } {
  const doc = parseObject(existingText);
  if (Array.isArray(fragment.hooks)) {
    if (doc.hooks !== undefined && !Array.isArray(doc.hooks)) {
      throw new Error("managed json: hooks must be an array");
    }
    doc.hooks = mergeHookEntries((doc.hooks ?? []) as unknown[], fragment.hooks);
  } else {
    if (!isObject(fragment.hooks)) throw new Error("managed json: the hook fragment must contain hooks");
    if (doc.hooks !== undefined && !isObject(doc.hooks)) {
      throw new Error("managed json: hooks must be an object");
    }
    const hooks = { ...((doc.hooks ?? {}) as JsonObject) };
    for (const [event, entries] of Object.entries(fragment.hooks)) {
      if (!Array.isArray(entries) || (hooks[event] !== undefined && !Array.isArray(hooks[event]))) {
        throw new Error(`managed json: hooks.${event} must be an array`);
      }
      hooks[event] = mergeHookEntries((hooks[event] ?? []) as unknown[], entries);
    }
    doc.hooks = hooks;
  }
  if (fragment.version !== undefined) doc.version = fragment.version;
  const next = print(doc);
  return { next, changed: next !== normalized(existingText) };
}
