export type ListEntry = { repo: string; ref?: string; raw: string }; // repo = "owner/name"

export function parseList(text: string): { entries: ListEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const entries = text
    .split("\n")
    .map((line) => line.split("#")[0]?.trim() ?? "")
    .filter((line) => line !== "")
    .map((raw) => {
      const at = raw.indexOf("@");
      const repo = at === -1 ? raw : raw.slice(0, at);
      const ref = at === -1 ? undefined : raw.slice(at + 1);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || ref === "") {
        throw new Error(`list entry is malformed: "${raw}" — expected owner/repo[@ref]`);
      }
      if (ref === undefined) warnings.push(`${repo}: no pin — required for a third-party repository (D32)`);
      return { repo, ref, raw };
    });
  return { entries, warnings };
}
