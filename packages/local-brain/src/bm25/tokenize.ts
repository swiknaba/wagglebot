const TOKEN_PATTERN = /(?:[\p{L}\p{N}_-]+\/)+[\p{L}\p{N}_.-]+|[\p{L}\p{N}][\p{L}\p{N}_-]*/gu;

const camelSegments = (value: string): string[] =>
  value
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[._-]+/u)
    .flatMap((part) => part.split(/\s+/u))
    .filter((part) => part.length > 0)
    .map((part) => part.toLocaleLowerCase());

const appendIdentifier = (tokens: string[], value: string): void => {
  const normalized = value.toLocaleLowerCase();
  tokens.push(normalized);

  for (const segment of camelSegments(value)) {
    if (segment !== normalized) tokens.push(segment);
  }
};

export const tokenize = (text: string): string[] => {
  const tokens: string[] = [];

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (token.includes("/")) {
      tokens.push(token.toLocaleLowerCase());
      for (const pathSegment of token.split(/[/.]/u)) {
        if (pathSegment.length > 0) appendIdentifier(tokens, pathSegment);
      }
    } else {
      appendIdentifier(tokens, token);
    }
  }

  return tokens;
};
