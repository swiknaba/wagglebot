import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(process.argv[2] ?? process.cwd());

function copyDependency(name, parent, destination) {
  const require = createRequire(join(parent, "package.json"));
  const source = dirname(require.resolve(`${name}/package.json`));
  const target = join(destination, "node_modules", name);
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (path) => !path.split("/").includes("node_modules", source.split("/").length),
  });
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  for (const dependency of Object.keys(pkg.dependencies ?? {})) copyDependency(dependency, source, target);
}

execFileSync("bun", ["run", "build"], { cwd: cliDir, stdio: "inherit" });
const stage = mkdtempSync(join(tmpdir(), "wagglebot-package-"));
try {
  const metadata = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
  for (const path of ["bin", "dist", "templates", "README.md"])
    cpSync(join(cliDir, path), join(stage, path), { recursive: true });

  const dependencies = Object.fromEntries(
    Object.entries(metadata.dependencies).filter(([, version]) => !version.startsWith("workspace:")),
  );
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify({ ...metadata, dependencies, devDependencies: {}, bundledDependencies: Object.keys(dependencies) }, null, 2),
  );
  for (const name of Object.keys(dependencies)) copyDependency(name, cliDir, stage);

  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory], {
      cwd: stage,
      encoding: "utf8",
    }),
  );
  process.stdout.write(`${join(outputDirectory, packed[0].filename)}\n`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
