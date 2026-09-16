export type SecretRuleId =
  | "nul_character"
  | "control_character"
  | "pem_private_key"
  | "cloud_access_key"
  | "bearer_token"
  | "token_assignment"
  | "password_assignment"
  | "high_entropy_credential";

export type ScanFinding = {
  ruleId: SecretRuleId;
  line: number;
  column: number;
};

export type ScanResult = {
  findings: ScanFinding[];
  count: number;
};

type Match = {
  ruleId: SecretRuleId;
  index: number;
};

const patterns: Array<{
  ruleId: Exclude<SecretRuleId, "nul_character" | "control_character" | "high_entropy_credential">;
  regex: RegExp;
}> = [
  { ruleId: "pem_private_key", regex: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g },
  { ruleId: "cloud_access_key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { ruleId: "bearer_token", regex: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  {
    ruleId: "token_assignment",
    regex: /(?<![A-Za-z0-9_])(?:[A-Za-z][A-Za-z0-9]*_)*(?:token|api[_-]?key)\s*(?:=|:)\s*\S+/gi,
  },
  {
    ruleId: "password_assignment",
    regex: /(?<![A-Za-z0-9_])(?:[A-Za-z][A-Za-z0-9]*_)*password\s*(?:=|:)\s*\S+/gi,
  },
];

const entropy = (value: string): number => {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  return [...frequencies.values()].reduce((total, count) => {
    const probability = count / value.length;
    return total - probability * Math.log2(probability);
  }, 0);
};

const locationAt = (text: string, index: number): Pick<ScanFinding, "line" | "column"> => {
  const preceding = text.slice(0, index);
  const line = preceding.split("\n").length;
  const lastNewline = preceding.lastIndexOf("\n");
  return { line, column: index - lastNewline };
};

const addRegexMatches = (matches: Match[], text: string): void => {
  for (const { ruleId, regex } of patterns) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) matches.push({ ruleId, index: match.index });
  }
};

const addControlMatches = (matches: Match[], text: string): void => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) matches.push({ ruleId: "nul_character", index });
    else if ((code >= 1 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      matches.push({ ruleId: "control_character", index });
    }
  }
};

const addHighEntropyMatches = (matches: Match[], text: string): void => {
  const regex =
    /(?<![A-Za-z0-9_])(?:[A-Za-z][A-Za-z0-9]*_)*(?:secret|credential|token|api[_-]?key)\s*(?:=|:)\s*([A-Za-z0-9+/=_-]{20,})/gi;
  for (const match of text.matchAll(regex)) {
    const value = match[1];
    if (value !== undefined && entropy(value) >= 3.5) {
      matches.push({ ruleId: "high_entropy_credential", index: match.index });
    }
  }
};

export const scanText = (text: string): ScanResult => {
  const matches: Match[] = [];
  addControlMatches(matches, text);
  addRegexMatches(matches, text);
  addHighEntropyMatches(matches, text);

  const findings = matches
    .sort((left, right) => left.index - right.index || left.ruleId.localeCompare(right.ruleId))
    .map(({ ruleId, index }) => ({ ruleId, ...locationAt(text, index) }));
  return { findings, count: findings.length };
};

export const assertSafeText = (text: string): void => {
  const result = scanText(text);
  const first = result.findings[0];
  if (first !== undefined) throw new Error(`unsafe text: ${first.ruleId}`);
};
