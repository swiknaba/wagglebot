# Component Memory

- Company repositories can reside in a validated subdirectory of a cloned repository. The cache must reject traversal and symlink escapes before activation.
- The CLI release artifact is produced by `packages/cli/scripts/pack.mjs`: Bun bundles workspace code, while external runtime dependencies are bundled so the tarball installs without `workspace:*` manifests.
