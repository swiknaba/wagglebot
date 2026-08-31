import { createRequire } from "node:module";

export type CliDeps = { write: (line: string) => void };

const version = (): string => {
  const require = createRequire(import.meta.url);
  const pkg: { version: string } = require("../package.json");
  return pkg.version;
};

export async function main(argv: string[], deps: CliDeps = { write: console.log }): Promise<number> {
  const [command] = argv;
  if (command === "--version" || command === "-v") {
    deps.write(version());
    return 0;
  }
  deps.write(`wagglebot: unknown command "${command ?? ""}". Run: wagglebot --help`);
  return 2;
}
