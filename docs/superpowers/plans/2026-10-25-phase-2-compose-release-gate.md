# Phase 2 Compose and Release Gate

**Goal:** Run the shared Phase 2 services with verified TLS and prove three local repositories across two systems can retrieve governed shared facts without publishing component memory.

**Architecture:** PostgreSQL/pgvector, the existing Ruby migrator, auth, registry, and the native memory worker run behind a loopback HTTPS gateway in Compose. The MCP hub and context engine stay on the workstation. An isolated fixture generates a private local CA, issuer key, SSH identity, company checkout, and three component repositories; no real credentials or user repositories are used. Explicit configured environment references carry only the required local credentials into the approved context subprocess.

The user has authorized implementation, local runtime installation, execution, review fixes, and completion without further approval prompts.

- [x] Add pinned container builds and Compose health/dependency sequencing, TLS database verification, and explicit service config mounts.
- [x] Add protected fixture generation and a repeatable host smoke runner using real SSH authentication, registry, memory HTTP/MCP, local hub, and context subprocess.
- [x] Prove cross-repository fact retrieval, local-memory privacy, offline local retrieval, cursor/budget/MCP bounds, publication/replacement/removal, restart replay, and Bridge isolation.
- [x] Complete independent Sol review and repair findings; run appropriate workspace/native/container gates and record exact results in the Phase 2 completion plan.

**Result, 2026-10-25:** all four tasks passed. See the final evidence in `2026-10-06-phase-2-completion.md`. GitHub workflow and release files remain unchanged at the user's request.
