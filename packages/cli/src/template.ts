export function renderTemplate(base: string, overlays: string[]): string {
  return `${[base, ...overlays]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n")}\n`;
}
