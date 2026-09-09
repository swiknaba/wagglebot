// repo = "owner/name", or the raw URL when isUrl is set
export type ListEntry = { repo: string; ref?: string; raw: string; isUrl?: boolean };

// A full git URL (https://, ssh://, git@host:...) names its own host. An optional ref follows
// after whitespace ("<url> <ref>"): "@" is taken by ssh URLs and "#" starts a comment.
const URL_ENTRY = /^(?:[a-z][\w+.-]*:\/\/|git@)/i;

export type ListOptions = { organization?: string[] };

// The "host/path" of an entry: no scheme, no user, no ".git" suffix. A port stays part of the host.
// A prefix under "wagglebot.organization" in the company package.json matches against this string.
export function hostPath(entry: ListEntry): string {
  if (entry.isUrl !== true) return `github.com/${entry.repo}`;
  const url = entry.repo.replace(/\.git$/, "");
  const scheme = /^[a-z][\w+.-]*:\/\//i.exec(url);
  // scp-like "[user@]host:path" has no scheme.
  if (scheme === null) return url.replace(/^[^@]+@/, "").replace(":", "/");
  return url.slice(scheme[0].length).replace(/^[^@/]+@/, "");
}

// A prefix matches whole segments: "github.com/acme" covers "github.com/acme/tools", never
// "github.com/acme-labs/tools". A declared prefix may carry a trailing slash, which is dropped.
// The comparison ignores case, because a host and a GitHub owner name are both case-insensitive.
export const insideOrganization = (entry: ListEntry, organization: string[]): boolean => {
  const hp = hostPath(entry).toLowerCase();
  return organization
    .map((prefix) => prefix.replace(/\/+$/, "").toLowerCase())
    .some((prefix) => hp === prefix || hp.startsWith(`${prefix}/`));
};

// A ref reaches git as an argument. One that starts with "-" would read as an option (P31).
const rejectOptionLikeRef = (raw: string, ref: string | undefined): void => {
  if (ref?.startsWith("-") === true) {
    throw new Error(`list entry is malformed: "${raw}" — a ref must not start with "-"`);
  }
};

export function parseList(text: string, options: ListOptions = {}): { entries: ListEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const entries = text
    .split("\n")
    .map((line) => line.split("#")[0]?.trim() ?? "")
    .filter((line) => line !== "")
    .map((raw): ListEntry => {
      if (URL_ENTRY.test(raw)) {
        const [url = raw, ref] = raw.split(/\s+/);
        rejectOptionLikeRef(raw, ref);
        return { repo: url, ref, raw, isUrl: true };
      }
      const at = raw.indexOf("@");
      const repo = at === -1 ? raw : raw.slice(0, at);
      const ref = at === -1 ? undefined : raw.slice(at + 1);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || ref === "") {
        throw new Error(`list entry is malformed: "${raw}" — expected owner/repo[@ref] or a full git URL`);
      }
      rejectOptionLikeRef(raw, ref);
      return { repo, ref, raw };
    });
  // D32: an entry outside the organization must pin a tag. An entry the organization owns may
  // track its default branch, because the same people control both repositories.
  for (const entry of entries) {
    if (entry.ref === undefined && !insideOrganization(entry, options.organization ?? [])) {
      warnings.push(
        `${entry.repo}: no pin. A repository outside your organization must pin a tag. Add "@<tag>" to the entry, or a space and the tag after a URL. If your organization owns the repository, list its host/path prefix under "wagglebot.organization" in package.json.`,
      );
    }
  }
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
