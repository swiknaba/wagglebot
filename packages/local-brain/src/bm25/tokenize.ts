const wordCharacter = /^[\p{L}\p{N}]$/u;
const identifierCharacter = /^[\p{L}\p{N}_-]$/u;
const pathCharacter = /^[\p{L}\p{N}_.-]$/u;

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
  const characters = Array.from(text);

  for (let index = 0; index < characters.length; ) {
    if (!wordCharacter.test(characters[index] ?? "")) {
      index += 1;
      continue;
    }
    const parts: string[] = [];
    while (identifierCharacter.test(characters[index] ?? "")) {
      parts.push(characters[index] ?? "");
      index += 1;
    }
    let token = parts.join("");
    let path = false;
    while (characters[index] === "/" && wordCharacter.test(characters[index + 1] ?? "")) {
      path = true;
      token += "/";
      index += 1;
      while (pathCharacter.test(characters[index] ?? "")) {
        token += characters[index] ?? "";
        index += 1;
      }
    }
    if (token.includes("/")) {
      tokens.push(token.toLocaleLowerCase());
      for (const pathSegment of token.split(/[/.]/u)) {
        if (pathSegment.length > 0) appendIdentifier(tokens, pathSegment);
      }
    } else {
      appendIdentifier(tokens, token);
    }
    if (path) continue;
  }

  return tokens;
};
