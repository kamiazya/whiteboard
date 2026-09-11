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

## Where the compiler API comes from

`scanner.ts` and `cycle-check.ts` import `@typescript/typescript6`, not
`typescript`. That is not a pin left behind by an upgrade: the workspace runs
TypeScript 7, whose root export is `lib/version.cjs` and carries no compiler
API at all, so `ts.createSourceFile` and friends have to come from the 6.x API
republished under that scoped name. Writing `import ts from 'typescript'` in a
new scan compiles to a wall of `Property 'X' does not exist on type
'typeof import(".../lib/version")'` that names neither the cause nor this file.

`typescript/unstable/ast` exposes the same symbols natively and is the eventual
home, but it is spelled unstable and these scans gate the build, so the stable
republish is the right footing until that changes.

## The cycle check

`cycle-check.ts` is value-aware (an `import type`-only edge does not count) and
static-analysis-only, which is why it cannot see a cross-package cycle at all.

It runs over the `src` of every entry in `repo-coverage.test.ts`'s
`CYCLE_SCAN_PACKAGES` — every package the `SHARED_LAYER_PACKAGES` list names,
plus both composition roots — over `.ts` and `.tsx` alike, which the boundary
scans beside it do not. Test files and `test-utils/` are out, the same line
those scans draw.

**It follows path aliases, and had to before `apps/web` could join**: that
package wrote 115 of its 554 intra-package value edges as `@/...`, a fifth of
them. Measured — with alias resolution removed, a real two-file cycle planted
in `apps/web/src` passes green.

So a package that adds an alias must declare it in `CYCLE_SCAN_ALIASES`, and
that sentence is no longer prose alone. `path aliases the cycle scan has to be
told about` classifies every BARE specifier in the same file set: one naming
no dependency the importing package declares resolves through some alias
mechanism, and it is either a declared `CYCLE_SCAN_ALIASES` prefix or a
`NON_PATH_BARE_SPECIFIERS` entry saying why it carries no intra-package edge
(three today, all of them virtual modules or a prefix pointing outside every
scanned tree). Probing the IMPORT rather than the mechanism is what makes it
one check instead of a list of mechanisms — tsconfig `paths`, a vite or
vitest `resolve.alias`, and a plugin's virtual module all surface the same
way. Mutation-checked in three directions: an undeclared `@/` import fails
naming the file, a fabricated exemption fails as stale, and declaring the
alias makes the same import pass — so the branch that accepts one is live
rather than dead code over an empty map.

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

**`ADAPTERS_REACHING_MECHANICS_CEILING` pins the count by equality — 21 today.**
It exists because the two both-sides guards reject a fabricated entry and a
stale one and have nothing to say about a real new edge added along with its
allowlist line, which is the ordinary way a list grows. Measured: a genuine
`routes/export.ts -> backup-in-progress` import, duly listed, passed all six
assertions, and the list went 37 -> 36 -> 35 -> 36 -> 40 in a week while the
rule and the test's own comment both said it could only shrink. Adding an edge
now fails until someone raises the ceiling deliberately, and paying one off
fails until someone lowers it. ADR-0018 is **Accepted** (2026-08-31) and
carried the burn-down order, and that scheduled burn-down is **COMPLETE**
(2026-09-02): `restore.ts`, `live-doc.ts`, `workspace-document.ts` and
`ws.ts` are all translation-only over the `LiveDocuments` /
`WorkspaceDocuments` seams. The 21 edges left belong to the unscheduled
adapters; paying one off still lowers the ceiling the same way.

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

## `brand-signature.test.ts`

BRAND.md says "Every brand surface renders this exact path" and, until this
scan, nothing checked it. The mark is copied into thirteen places across both
composition roots, two packages and `docs/` — a React component, five
standalone SVGs, two PNG generators, the widget's inline splash, a plugin's
registered geometry, and one prose comment quoting it — and none was pinned
against any other. A copy edited or truncated in one surface would have left
the product with two signatures, silently.

Three decisions worth not re-litigating:

- **The canonical path is READ FROM BRAND.md**, not written in the test. That
  file governs the mark; a guard with its own copy would be a fourteenth to
  keep in step, and the first to drift, since nothing would check it. What the
  test asserts about the doc instead is that what it quotes is a WHOLE path —
  the way the single source could itself go wrong.
- **It matches a PREFIX and then captures.** Matching the full path would find
  only the copies that are already correct and report a clean sweep. The
  capture's charset is SVG path COMMANDS and nothing else, which is what stops
  it running off the end of a sentence: `favicon.ts` quotes the mark mid-prose
  (`… 68 25 in`), and a general `[a-z]` swallows the `in` and reports that copy
  as divergent.
- **The scan skips its own file**, because it holds the prefix it searches for.
  Its first run reported itself — the same shape `selection-surface.test.ts`
  hit, where a file that NAMES a marker is not one that draws it. Every other
  test stays in scope on purpose: a fixture asserting a stale path is exactly
  the load-bearing copy a sweep leaves behind (`.claude/rules/vocabulary.md`
  records that trap).

`DIVERGENT` holds the one copy that deliberately differs — `error-mark.svg`,
where the signature carries on into a scribble — and is guarded from both
sides plus a reason check, mutation-verified in five directions: a truncated
copy, a nudged coordinate, a dropped entry, a fabricated entry, and a bare
one-word reason each fail, naming the file.

It pins the VIEW BOX too, from the same BRAND.md line. That box read
`88x66` in the doc while every surface drawing the bare mark used `88x56`, so
the DOC was the odd one out (user decision, 2026-09-11) — and the fix for a
disagreement nobody could see is to make one side derive from the other:
change the number in BRAND.md and every mark surface is reported until it
follows.

That needs one distinction the guard cannot infer, so `SURFACES` classifies
every file the scan finds as either `mark` (draws the bare signature, must
use the stated box) or `composes: <what it adds>` (needs a box of its own).
Both sides are guarded, which is the point: a new brand surface cannot be
added without answering which kind it is, and that is precisely the question
that went unasked while the doc and the surfaces disagreed.

"Unify on 88x56" therefore does NOT reach the composing surfaces, and the
framed ones show why: the board frame is a `84x62` rect at `(2,2)`, so its
bottom edge plus stroke reaches y≈65.3 and a 56-tall box clips it. The OG
card and the not-found mark are 66 tall because the FRAME requires it, not
because a copy of the mark's box drifted.

## `vocabulary-check.test.ts`

The one part of `.claude/rules/vocabulary.md` that can be mechanical rather
than prose: it fails on a retired word appearing anywhere under `apps/web/src`
or `packages/*/src`. Only words with no legitimate meaning left qualify — today
`slug` plus the three keeper-axis spellings, each with its own scan roots.
`canvas` never will, because it is correct for the spatial surface and
wrong only as the container noun, and telling those apart needs a reader.
`migrations/` is excluded as history, and `EXEMPT_FILES` carries the one other
file writing history, with its reason.

**The scan runs at module scope, and each file is read exactly once.** Both
halves were bought by the same CI flake: the four words share three scan roots
between them, so a per-word walk read 4826 files to cover 2141, and the whole
thing sat in a test body under vitest's 5000ms default. Warm it is ~255ms;
under the full parallel suite it measured 6315ms and timed out, reporting
`no source file says "slug"` and a five-second budget in one message — which
reads as a violation that is not there. Module evaluation is not bounded by a
per-test timeout, so the cost now lands in the collection phase, the same move
`.claude/rules/integrator-flow.md` prescribes for a heavy in-body
`await import()`. The read count is pinned by its own assertion rather than
left to a reader, because the redundancy was invisible in the source and
visible only as a timeout somewhere else. Directory WALKS are still repeated
per word and deliberately so: deduping them saves 9ms of the 255, which does
not buy a second thing to keep true.
