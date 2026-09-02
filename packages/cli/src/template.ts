export function renderTemplate(base: string, instructions: string[]): string {
  return `${[base, ...instructions]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n")}\n`;
}
