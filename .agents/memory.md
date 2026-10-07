# Component Memory

- Company repositories can reside in a validated subdirectory of a cloned repository. The cache must reject traversal and symlink escapes before activation.
- The CLI release artifact is produced by `packages/cli/scripts/pack.mjs`: Bun bundles workspace code, while external runtime dependencies are bundled so the tarball installs without `workspace:*` manifests.
- `examples/reference-setup` is a generic worker baseline. Product-specific coordination, runtime roles, and authorization enforcement belong in the integrating product, not its shared worker templates.
- Reader-focused writing guidance uses a short portable base prompt plus the first-party `writing-clear-text` skill. Its examples and evaluation cases ship as skill resources; the public reference setup only names the skill when an installed release provides it.
