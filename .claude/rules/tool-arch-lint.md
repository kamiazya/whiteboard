---
paths:
  - "tools/arch-lint/**"
---

# arch-lint — how the boundary guards are built

`.claude/rules/architecture-map.md` (always-on) says WHAT is enforced and is the
contract every session reads. This file is the mechanism: the allowlists, what
each scan actually covers, and the blind spots that were found by measuring
rather than by reading. It loads when you are editing the guards.

Every allowlist here is guarded from BOTH sides — an entry that names nothing
fails the build, exactly as a violation does — so a record cannot outlive the
debt it names, or decay into decoration.

## The cycle check

`cycle-check.ts` is value-aware (an `import type`-only edge does not count) and
static-analysis-only, which is why it cannot see a cross-package cycle at all.

It runs over `packages/mcp-server/src`, the eight shared-layer packages
(`model`, `codec`, `canvas-render`, `ports`, `facet-engine`, `search`,
`loro-adapter`, `server-core`), `canvas-viewer/src` and `apps/web/src`.

**It follows `@/...` path aliases, and had to before `apps/web` could join**:
that package writes 115 of its 554 intra-package value edges that way, a fifth
of them. Measured — with alias resolution removed, a real two-file cycle
planted in `apps/web/src` passes green. A package that adds an alias must
declare it in `repo-coverage.test.ts`'s `CYCLE_SCAN_ALIASES` or its edges
silently leave the graph.

`KNOWN_IMPORT_CYCLES` is the allowlist for cycles found and not yet fixed. It
is **currently empty**.

`package-cycle-check.ts` is the cross-PACKAGE half: a graph over every
workspace manifest (enumerated from pnpm-workspace's globs, so a new package
joins unlisted) reading `dependencies` AND `devDependencies` — the latter is
the door the direction check never inspects, and measured, the one real
cycle (canvas-render <-> plugin-visual) enters through it.
`KNOWN_PACKAGE_CYCLES` allowlists it, both-sides guarded; the type-only
property of the closing edge stays with
`plugin-visual/src/canvas-render-type-only.test.ts`, because a manifest
cannot see how an import is spelled.

## What the composition roots do and do not get

`mcp-server` and `apps/web` are registered for the dependency-direction guard,
and both have their `src` in the cycle scan. What stays unscanned for them is
the BOUNDARY scan (banned imports/globals) — they are the packages allowed
`node:*`, DOM and inversify — and their third-party surface is open by design,
so neither carries an allowed-third-party list.

`apps/web`'s own source is policed by a separate enforcer OUTSIDE this tool:
`packages/mcp-server/src/server/release/web-app-boundary.test.ts` fails the
build when it imports a Node builtin or reaches into `src/server` / `src/cli` /
`src/daemon`. The split is deliberate — that boundary is the daemon package's
own published surface — but it means "is this checked?" has two answers
depending on the rule.

## `adapter-mechanic-check.ts` and its three lists

**A mechanic is named by its FULL path under `store/`, at whatever depth**, so
the database layer reads as `db/<module>`. It used to be invisible: the matcher
read a single path segment, so every `store/db/**` import from an adapter
passed silently. That was a blind spot rather than a decision, and it read as
coverage until someone measured it — four such edges existed when the regex was
widened, all under `mcp/`. The depth is unbounded on purpose: `store/db/` is
how deep the tree happens to go today, not a property of it, and a matcher
enumerating the depths it has seen is the same blind spot one directory
further down.

**`ADAPTERS_REACHING_MECHANICS`** records the edges that exist today.

**`ADAPTERS_REACHING_MECHANICS_CEILING` pins the count by equality — 25 today.**
It exists because the two both-sides guards reject a fabricated entry and a
stale one and have nothing to say about a real new edge added along with its
allowlist line, which is the ordinary way a list grows. Measured: a genuine
`routes/export.ts -> backup-in-progress` import, duly listed, passed all six
assertions, and the list went 37 -> 36 -> 35 -> 36 -> 40 in a week while the
rule and the test's own comment both said it could only shrink. Adding an edge
now fails until someone raises the ceiling deliberately, and paying one off
fails until someone lowers it. ADR-0018 is **Accepted** (2026-08-31) and
carries the burn-down order; `restore.ts`, `live-doc.ts` and
`workspace-document.ts` are paid off (their operations live in server-core
behind the `LiveDocuments`/`WorkspaceDocuments` seams), and the one
remaining scheduled adapter (`ws.ts`) holds 4 of the 25.

`corrupt-stored-data` is excluded and says why: an error taxonomy an adapter
reads to pick a status code is translation, which is an adapter's job, and
listing it would put five permanently-unshrinkable entries in a list whose
whole value is that it shrinks.

**`ADAPTER_SCAN_EXEMPT_FILES`** carries by FILE what the wiring exemption —
a directory list (`di/`, `app.ts`, `http-server.ts`) — misses: a composition
root living inside an adapter tree. Today that is `mcp/index.ts`, the McpServer
factory and stdio entry point, which makes the same `createContainer` /
`resolveServerDeps` calls `http-server.ts` does. It is separate from
`ADAPTERS_REACHING_MECHANICS` on purpose: an exemption is a CLASSIFICATION,
not debt, and a composition root's edges will never shrink.

The other file that reached `store/db` from under `mcp/` was moved instead of
exempted: `mcp/session-resolver.ts` had stopped being an MCP concern the moment
`http-server.ts` called it, so it is now `server/current-workspace.ts` — which
also retires a name that said `session` about a workspace.

## `vocabulary-check.test.ts`

The one part of `.claude/rules/vocabulary.md` that can be mechanical rather
than prose: it fails on a retired word appearing anywhere under `apps/web/src`
or `packages/*/src`. Only words with no legitimate meaning left qualify — today
`slug`. `canvas` never will, because it is correct for the spatial surface and
wrong only as the container noun, and telling those apart needs a reader.
`migrations/` is excluded as history, and `EXEMPT_FILES` carries the one other
file writing history, with its reason.
