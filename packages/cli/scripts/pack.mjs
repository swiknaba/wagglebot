import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(process.argv[2] ?? process.cwd());

function copyDependency(name, parent, destination, optional = false, ancestors = new Set()) {
  const require = createRequire(join(parent, "package.json"));
  let packagePath;
  try {
    packagePath = require.resolve(`${name}/package.json`);
  } catch (error) {
    if (optional && error?.code === "MODULE_NOT_FOUND") return;
    throw error;
  }
  const source = dirname(packagePath);
  const target = join(destination, "node_modules", name);
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (path) => {
      const relativePath = relative(source, path);
      return relativePath !== "node_modules" && !relativePath.startsWith(`node_modules${sep}`);
    },
  });
  const sourcePath = realpathSync(source);
  if (ancestors.has(sourcePath)) return;
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const nestedAncestors = new Set(ancestors).add(sourcePath);
  for (const dependency of Object.keys(pkg.dependencies ?? {}))
    copyDependency(dependency, source, target, false, nestedAncestors);
  for (const dependency of Object.keys(pkg.optionalDependencies ?? {}))
    copyDependency(dependency, source, target, true, nestedAncestors);
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
    JSON.stringify(
      { ...metadata, dependencies, devDependencies: {}, bundledDependencies: Object.keys(dependencies) },
      null,
      2,
    ),
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
