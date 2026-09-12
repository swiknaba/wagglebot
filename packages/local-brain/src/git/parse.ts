import type { GitCommit } from "../types";

export const parseLog = (text: string): GitCommit[] =>
  text.split("\u001e").flatMap((record) => {
    const fields = record.split("\0");
    const [commit, subject, body, authorDate, author, ...paths] = fields;
    if (
      commit === undefined ||
      subject === undefined ||
      body === undefined ||
      authorDate === undefined ||
      author === undefined ||
      commit === ""
    ) {
      return [];
    }
    return [
      {
        commit,
        subject,
        ...(body === "" ? {} : { body }),
        authorDate,
        authors: author === "" ? [] : [author],
        changedPaths: paths
          .flatMap((path) => path.split("\u001f"))
          .map((path) => (path.startsWith("\n") ? path.slice(1) : path))
          .filter((path) => path !== ""),
      },
    ];
  });

export const parseBlameCommits = (text: string): string[] => {
  const commits = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^\^?([0-9a-f]{40})\s/iu);
    if (match?.[1] !== undefined) commits.add(match[1]);
  }
  return [...commits];
};
