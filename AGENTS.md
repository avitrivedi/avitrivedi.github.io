# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Run `npm run check` for the complete dependency-free lint, unit/browser, production-build, and `dist/` exclusion gate. Browser coverage is mandatory in CI; see `README.md` for local browser discovery details.
- Public annotations are build-generated inert SVG from reviewed `annotations/*.json`; the schema, stable anchors, limits, stale-hash behavior, and local-only `npm run annotations:author` workflow are authoritative in `annotations/README.md`.
- `tools/` is authoring-only and must never enter Pages output. `scripts/verify-dist.mjs` enforces this production boundary.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
