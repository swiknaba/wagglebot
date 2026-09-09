// repo = "owner/name", or the raw URL when isUrl is set
export type ListEntry = { repo: string; ref?: string; raw: string; isUrl?: boolean };

// A full git URL (https://, ssh://, git@host:...) names its own host. An optional ref follows
// after whitespace ("<url> <ref>"): "@" is taken by ssh URLs and "#" starts a comment.
const URL_ENTRY = /^(?:[a-z][\w+.-]*:\/\/|git@)/i;

export function parseList(text: string): { entries: ListEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const entries = text
    .split("\n")
    .map((line) => line.split("#")[0]?.trim() ?? "")
    .filter((line) => line !== "")
    .map((raw): ListEntry => {
      if (URL_ENTRY.test(raw)) {
        const [url = raw, ref] = raw.split(/\s+/);
        return { repo: url, ref, raw, isUrl: true };
      }
      const at = raw.indexOf("@");
      const repo = at === -1 ? raw : raw.slice(0, at);
      const ref = at === -1 ? undefined : raw.slice(at + 1);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || ref === "") {
        throw new Error(`list entry is malformed: "${raw}" — expected owner/repo[@ref] or a full git URL`);
      }
      if (ref === undefined) warnings.push(`${repo}: no pin — add "@<tag-or-commit>"`);
      return { repo, ref, raw };
    });
  return { entries, warnings };
}

// A pin that names a release: "v1.2.3" or "1.2". A branch or a commit never matches.
export const VERSION_TAG = /^v?\d+(\.\d+)*$/;

// Rewrites the one list line whose entry text equals `raw`, and keeps everything else on that
// line: indentation and a trailing comment. A comment that mentions the same text, and any
// second identical line, stay untouched.
export function replaceListLine(text: string, raw: string, next: string): string {
  let done = false;
  return text
    .split("\n")
    .map((line) => {
      if (done) return line;
      const hash = line.indexOf("#");
      const code = hash === -1 ? line : line.slice(0, hash);
      if (code.trim() !== raw) return line;
      done = true;
      const start = code.indexOf(raw);
      return `${line.slice(0, start)}${next}${line.slice(start + raw.length)}`;
    })
    .join("\n");
}
