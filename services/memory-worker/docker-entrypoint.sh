#!/bin/sh
set -eu

IFS= read -r MEMORY_GITLEAKS_SHA256 < /usr/local/share/gitleaks.sha256
export MEMORY_GITLEAKS_SHA256

exec bun services/memory-worker/src/index.ts "$@"
