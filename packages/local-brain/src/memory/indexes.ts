import type { LocalMemoryConcept, LocalMemoryPath } from "../types";

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  architecture: "Durable structural constraints and boundaries.",
  conventions: "Repository-specific rules that source code does not state.",
  commands: "Verified commands for building, testing, checking, and running the component.",
  decisions: "Accepted choices and the evidence or rationale behind them.",
  warnings: "Traps, hazards, and costly failure modes.",
  learnings: "Durable, verified lessons that should survive the current session.",
};

const CATEGORY_TITLES: Record<string, string> = {
  architecture: "Architecture",
  conventions: "Conventions",
  commands: "Commands",
  decisions: "Decisions",
  warnings: "Warnings",
  learnings: "Learnings",
};

type Directory = {
  relativePath: string;
  concepts: LocalMemoryConcept[];
  children: Set<string>;
};

type IndexEntry = {
  title: string;
  path: string;
  description?: string;
};

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const compareByTitleAndPath = (left: IndexEntry, right: IndexEntry): number =>
  compare(left.title.toLowerCase(), right.title.toLowerCase()) || compare(left.path, right.path);

const displayText = (value: string): string => value.replace(/\r\n?/gu, " ").replace(/\n/gu, " ");

const linkLabel = (value: string): string => displayText(value).replaceAll("[", "\\[").replaceAll("]", "\\]");

const encodePathDestination = (path: string): string =>
  path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/gu,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");

const titleCaseDirectory = (name: string): string =>
  name
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(" ");

const directoryTitle = (relativePath: string): string => {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return CATEGORY_TITLES[name.toLowerCase()] ?? titleCaseDirectory(name);
};

const directoryDescription = (relativePath: string): string | undefined => {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return CATEGORY_DESCRIPTIONS[name.toLowerCase()];
};

const bullet = (entry: IndexEntry): string => {
  const description =
    entry.description === undefined || entry.description.trim() === "" ? "" : `: ${displayText(entry.description)}`;
  return `- [${linkLabel(entry.title)}](${encodePathDestination(entry.path)})${description}`;
};

const linkPath = (fromDirectory: string, target: string): string => {
  if (fromDirectory === "") return target;
  return target.slice(fromDirectory.length + 1);
};

const conceptEntry = (directory: string, concept: LocalMemoryConcept): IndexEntry => {
  const description =
    directory === "" && concept.relativePath === "component.md"
      ? "Repository purpose, boundaries, and ownership."
      : concept.description;
  return {
    title: displayText(concept.title),
    path: linkPath(directory, concept.relativePath),
    ...(description === undefined ? {} : { description }),
  };
};

const childEntry = (directory: string, child: string): IndexEntry => ({
  title: directoryTitle(child),
  path: linkPath(directory, `${child}/index.md`),
  ...(directoryDescription(child) === undefined ? {} : { description: directoryDescription(child) }),
});

const sortEntries = (entries: IndexEntry[]): IndexEntry[] => entries.sort(compareByTitleAndPath);

const renderRoot = (directory: Directory): string => {
  const entries = sortEntries([
    ...directory.concepts.map((item) => conceptEntry("", item)),
    ...[...directory.children].map((child) => childEntry("", child)),
  ]);
  const lines = ["---", 'okf_version: "0.2"', "---", "", "# Component Memory"];
  if (entries.length > 0) lines.push("", ...entries.map(bullet));
  return `${lines.join("\n")}\n`;
};

const renderNested = (directory: Directory): string => {
  const lines = [`# ${directoryTitle(directory.relativePath)}`];
  const description = directoryDescription(directory.relativePath);
  if (description !== undefined) lines.push("", description);

  const childEntries = sortEntries([...directory.children].map((child) => childEntry(directory.relativePath, child)));
  if (childEntries.length > 0) lines.push("", ...childEntries.map(bullet));

  const groups = new Map<string, LocalMemoryConcept[]>();
  for (const concept of directory.concepts) {
    const group = groups.get(concept.type) ?? [];
    group.push(concept);
    groups.set(concept.type, group);
  }
  const sortedGroups = [...groups.entries()].sort(
    ([left], [right]) => compare(left.toLowerCase(), right.toLowerCase()) || compare(left, right),
  );
  for (const [type, concepts] of sortedGroups) {
    const entries = sortEntries(concepts.map((item) => conceptEntry(directory.relativePath, item)));
    lines.push("", `## ${displayText(type)}`, "", ...entries.map(bullet));
  }
  return `${lines.join("\n")}\n`;
};

export const renderMemoryIndexes = (concepts: LocalMemoryConcept[]): Map<LocalMemoryPath, string> => {
  const directories = new Map<string, Directory>();
  directories.set("", { relativePath: "", concepts: [], children: new Set() });

  for (const concept of concepts) {
    const parts = concept.relativePath.split("/");
    parts.pop();
    let parent = "";
    for (const part of parts) {
      const current = parent === "" ? part : `${parent}/${part}`;
      directories.get(parent)?.children.add(current);
      if (!directories.has(current))
        directories.set(current, { relativePath: current, concepts: [], children: new Set() });
      parent = current;
    }
    directories.get(parent)?.concepts.push(concept);
  }

  const result = new Map<LocalMemoryPath, string>();
  const orderedDirectories = [...directories.values()].sort((left, right) =>
    compare(left.relativePath, right.relativePath),
  );
  for (const directory of orderedDirectories) {
    if (directory.relativePath === "") {
      result.set(".agents/memory/index.md", renderRoot(directory));
    } else {
      result.set(`.agents/memory/${directory.relativePath}/index.md`, renderNested(directory));
    }
  }
  return result;
};
