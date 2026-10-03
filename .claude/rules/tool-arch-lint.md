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
plus `mcp-server`, `apps/web` and `apps/extension` — over `.ts` and `.tsx` alike. Test files and
`test-utils/` are out, the same line the boundary scans draw.

**Which packages those scans run on is `scan-packages.ts`'s
`SHARED_LAYER_PACKAGES`, and nothing used to say it was complete**: `scene` and `reference-graph` were in
`ARCHITECTURE_MAP` and rule 1 for months while no per-package scan ran on
either (a `node:fs` import in `reference-graph` passed).
`workspace-scan-coverage.test.ts` (`every workspace is in a per-package scan
list`) now fails on any `packages/*`, `apps/*` or `tools/*` manifest in
neither that list nor `COMPOSITION_ROOTS`, unless `NOT_BOUNDARY_SCANNED` gives
it a reason (`tools/arch-lint` and `tools/checks`: Node programs whose job is
the filesystem and the GitHub API; guarded from both sides). `tools/*` is a
workspace glob in `pnpm-workspace.yaml` and the manifest cycle check reads it,
so a list that stopped at `packages` and `apps` left a new tool in no scan and
no guard that said so.

`apps/extension` is the one composition root whose SOURCE is boundary-scanned
(`BOUNDARY_SCANNED_ROOTS`, which `BOUNDARY_SCAN_PACKAGES` adds to the shared
layer): it runs only in a page and a service worker, so a `node:*` import in
its relay is a defect as much as in `model`, and a planted one passed every
guard while the root was unread. Only its page script, `content.ts`, is exempt
from `dom-global` (touching `window` is its job; the background service worker
has no DOM) and nothing else is; its direction and dependency list stay with
the composition-root checks.

The boundary scan reads `.ts` and `.tsx` for EVERY kind. It used to read
`.tsx` for the two import kinds only, on the premise that a component may touch
the DOM, and that premise is what left `facet-ui` and `plugin-visual` exempt
from `dom-global` package-wide: a `document.title` planted in `plugin-visual`'s
data half passed. A DOM use is now excused where it lives — `facet-ui`'s
`catalog-popover.tsx` and `daemon-client`'s `api-client.ts` by per-file entry,
`canvas-viewer` (seven files) still package-wide — and `plugin-visual`, whose
default entry runs in Node and the layout worker, has none.

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

`type-cycle-check.ts` is the same graph with `import type` edges kept, because a
type-only edge never fails at load and so the value scan above is blind to a
loop closed by one. It is not harmless: its first run found twelve components the value
scan called clean, all since broken, so `KNOWN_TYPE_CYCLES` is **currently
empty**. It is the
ledger, pinned from both sides like the others: a
component not listed fails naming its members, and a listed one that stopped
being a component fails as stale. Each entry carries a REASON, since unlike a
value cycle there is nothing it crashes on to argue for fixing it. A component
the value scan already reports with the same members is left to
`KNOWN_IMPORT_CYCLES`, so one debt is never a two-place edit. It follows the
same `CYCLE_SCAN_ALIASES` as the value scan, because it shares the scan's file
set. The usual fix is a leaf module that owns the type both sides name
(`references/resolved.ts`, `pointer-inputs.ts`, `canvas-commands.ts`), not an
exemption.

`package-cycle-check.ts` is the cross-PACKAGE half: a graph over every
workspace manifest (enumerated from pnpm-workspace's globs, so a new package
joins unlisted) reading `dependencies` AND `devDependencies` — the latter is
the door the direction check never inspects, and measured, the one real
cycle (canvas-render <-> plugin-visual) entered through it.
`KNOWN_PACKAGE_CYCLES` is the allowlist for one found and not yet fixed, and
it is **currently empty**: the cycle it held was dissolved by extracting
`packages/scene`, so plugin-visual no longer reaches the renderer at all.
What replaced the allowlist is stricter than what guarded it — the entry
needed a hand guard for a type-only import a manifest cannot see, and
`plugin-visual/src/renderer-independence.test.ts` now pins that there is no
import of the renderer of ANY kind.

## An exemption is per FILE when only one file needs it

`exemptBoundaryViolationKinds` exempts a kind for a whole package, which is
right for `dom-global` in a package that is DOM code throughout (`canvas-viewer`)
and wrong for a use that lives in one file (`apps/extension`'s is `content.ts`'s
alone). `canvas-viewer` carried `node-ambient-global` package-wide
for a single `Buffer` in `widget/build-fonts-module.ts`, while the rule said
one file: `process.env.X` or `__dirname` in `mount.ts` or `widget-entry.ts` —
which ship into the browser and the widget iframe — passed (measured, both).
`exemptBoundaryFiles` keys the exemption by path under `src/`, and `per-file
boundary exemptions` fails an entry whose file is gone or no longer contains
that kind. It is file-granular, not line-granular: a second `process` use in
the exempt file passes, which is the cost of not scanning for the line.

The `test-framework-import` kind (`vitest`, `vitest/*`, `@vitest/*`,
`fast-check`, `@fast-check/*` from a file that ships) is the same mechanism:
five files import one on purpose today — three `canvas-render` benches, a
`search` bench and `facet-engine`'s `./testing` entry — and each is a per-file
entry with its reason, so a sixth fails instead of arriving unannounced. A
`test-utils/` directory and a `.test.ts` are never walked, which is why the
kind has nothing to say about them.

## Named blind spots in the scanner and the resolver

Each of these has zero instances today, was probed by planting one, and is
recorded rather than closed because closing it costs more than it catches.
They are named so a clean result is not read as covering them.

- **A computed specifier.** `import(\`node:${name}\`)`, `import(name)` and
  `createRequire(...)('x')` name no module statically; only a string or a
  template with NO substitution is read (`collectModuleSpecifiers`).
- **`import.meta.glob` and path-built reads.** A glob's pattern and a
  `new URL('../x', import.meta.url)` carry a path no specifier scan sees; the
  relative-import escape guard reads import specifiers only.
- **The DOM list is a deny-list of thirteen names.** `location` and `Image` are
  left out on purpose: the scan matches identifiers without scope analysis, and
  `daemon-client`'s `WindowLike` declares a `location` property. A read of
  either in a shared package passes. `globalThis['document']` (element access)
  and `const { document } = globalThis` are not read either, only
  `globalThis.document`.
- **Type-only is syntactic.** An un-annotated named import of an interface reads
  as a value edge, so the value cycle scan can over-report, never under-report.
- **The test-framework kind names three families** (`vitest`, `fast-check`,
  `@testing-library/*`). `msw` and `playwright` from shipped source are not a
  kind.
- **The cycle resolver is intra-package.** It follows relative specifiers and
  declared aliases and drops anything else, so a cross-package cycle through a
  subpath is `package-cycle-check.ts`'s job and only at manifest level.

What WAS closed in the same pass: a template-literal dynamic import, `require()`
and `import x = require()`, `globalThis.<banned name>`, `inversify/…` and
`@inversifyjs/*`, `from '.'` / `'..'` / `'../'` and an explicit `.ts` in the
cycle resolver, and `peerDependencies` / `optionalDependencies` in the direction
and allowed-dependency checks (neither field was read, so a reversing edge
declared in one passed).

## `port-conformance-ledger.test.ts`: every store implementer runs its suite

The three `describe*Conformance` suites make the browser's and the daemon's
stores readings of one contract, and nothing tied `implements DocumentStore |
DocumentIndex | BlobStore` to a call of the matching one — two of the twelve
production implementers were added after the suites, each by someone
remembering. The population is derived from the AST (every `implements` under
`packages/*/src` and `apps/*/src`, tests included) and each member is ledgered
to the test file that calls its suite AND constructs it with `new`. Both sides
fail; `FakeDocumentStore`, a test double, is exempted with its reason. Blind
spot: only `implements` clauses are read, so an object literal typed as a port
is not a member.

## `relative-import-escape.test.ts`: the door the manifest checks cannot see

Direction, allowed dependencies and package cycles all read MANIFESTS, and a
relative specifier walks past every one: `export * from
'../../codec/src/index.js'` planted in `packages/model/src` is an upward edge and
a package cycle, and left the whole project green with `tsc` passing in `model`.
Every relative specifier in every workspace's `src` (`packages/*`, `apps/*`,
`tools/*`, tests and `test-utils` included) must now resolve inside that
workspace. No shipped file may escape; the six tests that do, on purpose, are
`ESCAPES` entries with reasons (three `mcp-server` release-policy tests reading
`tools/arch-lint/src/job-section.ts` through its `.js` specifier, and three tests that read the root manifest
or the root vitest config they police), both-sided like every ledger here. The
workspace list is `scan-roots.ts`'s `workspaceDirs()`, enumerated from the three
`pnpm-workspace.yaml` groups, so a new one joins without being listed.

Its second half pins the cycle scan's own blind spot: `cycle-check.ts` resolves
against TypeScript files and DROPS what it cannot, which reads as "no edge".
From shipped source that is eight edges today, all assets (two font `?url`
imports, four SVGR `?react` components, one JSON schema, one stylesheet),
ledgered in `UNRESOLVED_IN_SHIPPED_SOURCE`. A relative import that names no file
at all fails as dangling — a `?raw` or `?url` query would otherwise hide it from
`tsc` — and a new dropped edge fails as unlisted until someone says what it is.
Measured when written: 3087 files, 8558 relative edges, 97 resolving to no
TypeScript file, 89 of them from tests that sit outside the cycle graph.

Named blind spot: only import specifiers are read. `import.meta.glob` and a
`new URL('../x', import.meta.url)` carry paths this does not see.

## `source-direction-check.test.ts`: source imports against the map

The manifest checks exempt `devDependencies`, so a shared-layer file could
import any workspace package declared there and pass every guard (a planted
`search -> codec` did). This scan reads each shared-layer production file's
workspace specifiers from the AST against `allowedInternalDeps`;
`facet-engine/testing`'s `model/test-utils` import is its one ledgered
exemption. `scene-types-only.test.ts` asks the compiler (`ts.transpileModule`)
whether `packages/scene` emits code, where a regex over `export const` passed
five runtime forms. `scan-roots.ts` derives `apps/*/src` like the other groups
(the extension's source was outside every walk), and the per-package table
lives in `architecture-map.data.ts` beside `architecture-map.ts`'s helpers.

## The always-on table is parsed, not trusted

`architecture-map.md`'s table is a second hand-kept copy of `ARCHITECTURE_MAP`,
and they had drifted in six rows: loro-adapter listed `ports` the map says it
deliberately lacks, plugin-visual a `lucide-react` the map records as gone, and
three rows spelled a package by a name nothing resolves (`render`, `crdt`).
`architecture-map.md table agrees with ARCHITECTURE_MAP` reads the "Checked
dependencies" column: one row per mapped package, the workspace names in each
cell equal to `allowedInternalDeps` (both directions), and every other token a
recorded `allowedThirdParty` entry (`remark` stands for the `remark-*` family).
Third-party names are checked one way only, since a cell is a summary of that
list; a token containing a space is prose and skipped.

## What the composition roots do and do not get

`mcp-server`, `apps/web` and `apps/extension` are registered for the
dependency-direction guard — over `devDependencies` too, which a shared package's
check ignores. `mcp-server` declares all twelve workspace packages it uses there
(tsdown's `noExternal` inlines them), so a `dependencies`-only read passed
`@kamiazya/whiteboard-web` added to it: measured. Each root's allowed set must
equal what its manifest declares (an unused allowance fails) and no root may
depend on another. `mcp-server`, `apps/web` and `apps/extension` also have their
`src` in the cycle scan. What stays unscanned for `mcp-server` and `apps/web` is
the BOUNDARY scan (banned imports/globals) — they are the packages allowed
`node:*`, DOM and inversify — while `apps/extension` is scanned (see above). Their
third-party surface is open by design, so none carries an allowed-third-party list.

`apps/web`'s own source is policed by a separate enforcer BESIDE this tool's
scans: `web-app-boundary.test.ts` fails the build when it imports a Node
builtin or reaches into `src/server` / `src/cli` / `src/daemon`. It runs in this
project but reads source text rather than `architecture-map.ts`, so "is this
checked?" still has two answers depending on the rule.

## Repo-policy guards live here, not under the package they were written beside

Guards over files that belong to no package — workflows, the Dockerfile, root
manifests, docs, the always-on rule corpus, `apps/web`'s source — belong in
this project, which pre-push and CI's `test-shared` run on every change; a
guard filed under `mcp-server` ran only when `mcp-node` did.
`file-size-budget.test.ts` records the same argument for the size ledgers.

**The rule for where one goes**: it reads repo-root files or other packages'
text, runs no product code, and imports nothing from a package — arch-lint takes
no package dependency and finds the root through `scan-roots.ts`'s `REPO_ROOT`,
never a package's `repoRoot()` helper. It stays in its package, with a reason,
only when it cannot meet that: it imports the daemon's source (a docs example
parsed through the daemon's own output schema, the env vars the server reads),
it is a property test through the packages' fast-check prelude, it runs or
inspects the built artifact, or it asserts an ENVIRONMENT premise rather than
scanning (`local-node-version.test.ts` — a wrong Node major should be explained
where the failures it causes are, not newly block a push). A test that is part
policy and part daemon is split along that seam rather than kept whole.

**`repo-root-reads.test.ts` pins it**: a `*.test.ts` under `packages/*/src`
that imports the repo-root helper, names `.github/`, `.claude/`, a Dockerfile,
`lefthook.yml` or `pnpm-workspace.yaml`, or counts `../` up to the root or one
of its entries, fails unless it is in `STAYS_IN_PACKAGE` with a reason. That
list is guarded from both sides (a gone file or one that stopped reading the
root is stale) and the scan asserts it reached its tests. The detector is
textual and has two named blind spots: a root reached through a variable plus
`'..'` arguments (`canvas-viewer`'s `docs-guard.test.ts` is one) and a bare
`'docs/…'` literal. Comments are stripped first, because four files named a rule
in prose.

Some guards left behind a daemon-side twin that cannot move: three of the
fast-check policy files still import `job-section.ts` from here by relative
path, the one place a package test reaches into this tool.

## `adapter-di-import-check.test.ts`: an adapter composes nothing

The sibling of the mechanic check, one layer up: `server/routes/**` and
`server/mcp/**` may not import `di/`, statically or through `await import`.
Fourteen call sites in eight routers used to fall back to a `ServerDeps` they
resolved themselves when handed none — a second composition path, carrying
none of what the root attaches, and one that let a router threaded without the
field compile clean and pass every test that only ever took the fallback.
`serverDeps` is required on every router and on `createApp` now, and tests
get theirs from `routes/_test-helpers.ts`'s `resolveTestServerDeps`. There is
no exemption: the stdio root, which does compose its own deps, is
`server/stdio-root.ts` — beside the other roots, outside the adapter trees —
and `server/mcp/server.ts`, the McpServer factory, takes the deps it is handed.

It reads import specifiers from the AST (`collectRelativeImportEdges`) and
judges them by where they RESOLVE, not by how they are spelled: a text regex
missed a side-effect import, a template `import()` and a `require`, and read a
commented-out import as a violation.

**What an adapter file IS is `adapter-files.ts`, once.** Four checks each
carried a copy of `ADAPTER_DIRS` and the predicate, and the copies had
diverged; a directory added to one was a blind spot in the other three.

## `adapter-mechanic-check.ts` and its lists

**The finder reads import specifiers from the AST** (`collectRelativeImportEdges`,
the walk every other import scan uses), not `from '...'` text. The text match
missed a dynamic `import()` and a side-effect `import '...'` and read a
commented-out import as an edge, and it disagreed with
`adapter-di-import-check.test.ts` about the same trees. Type-only imports still
count: an adapter holding a store's TYPE is the same coupling.

**Adapter entitlements are a NAMED list.** `adapter-reach.ts`'s
`ADAPTER_ENTITLED_MECHANICS` names each module an adapter may import
(`modules: string[]`, a reason each); everything else in the mechanics layer,
and `daemon/`, is a mechanic an adapter must ledger. A module in `security/` or
`tenant/` is not entitled by its directory — `user-deletion` and
`storage-report` are neither `*-store` nor `data-layout`, and the old directory
patterns waved both through (`createApp` now hands the runtime route its
storage report, so that edge is gone). Add an entitlement by name; the list
is both-sided, so an entitled module no adapter imports fails too.

**What counts as a mechanic is wider than `store/`**: a `security/*-store` (the
people, session, key and invitation rows), anything under the daemon's own
`daemon/` directory, `tenant/data-layout`, and the `export/` directory.
`export/` is the keeper rendering a stored document and keeping fonts:
`headless-export` reads the document through the store's module-level handle and
the font modules join the data directory, so an operation welded to storage, the
shape ADR-0018 names. It is matched whole, so a new module there is judged; a
pure renderer an adapter needs goes in `MECHANICS_NOT_SCANNED`. Their edges are spelled with the
directory (`security/member-profile-store`, `daemon/<module>`,
`tenant/data-layout`) so they cannot be read as a same-named `store/` module.
Policy beside them (`bearer-token`, `credential-resolver`, the tenant id) is
translation an adapter is entitled to, and is not matched. A `_test-*` helper
under an adapter tree is scaffolding, not an adapter, and is skipped.

**A mechanic under `store/` is named by its FULL path, at whatever depth**, so
the database layer reads as `db/<module>`. A matcher reading one segment let
every `store/db/**` import pass silently (four edges, all under `mcp/`, when it
was widened). The depth is unbounded on purpose: `store/db/` is
how deep the tree happens to go today, not a property of it, and a matcher
enumerating the depths it has seen is the same blind spot one directory
further down.

**`ADAPTER_HELPER_FILES` names top-level `server/*.ts` helpers scanned as
adapters.** A route importing a helper that imports `store/` shows no edge, so
the reach hides behind every caller: `workspace-handle.ts` serves nine routes
through `workspaceRegistry()`. It is classified as an adapter, not a mechanic —
what it holds is translation (the 400 for a malformed address, the per-request
memo) with one registry read inside, and a mechanic classification would ledger
nine routes for one debt. The list is NAMED, not discovered, and that is a known
blind spot: following every `server/*.ts` an adapter imports also reaches
`shared-background-work.ts`, whose edges are composition-root wiring, and a new
helper that reaches a mechanic stays invisible until someone lists it. Guarded
from one side: each entry must exist and be imported by an adapter. Deeper hops
(a helper's helper, a re-export barrel) are not followed either.

**`ADAPTERS_REACHING_MECHANICS`** records the edges that exist today.

**`ADAPTERS_REACHING_MECHANICS_CEILING` pins the count by equality — see the constant.**
It exists because the two both-sides guards reject a fabricated entry and a
stale one and have nothing to say about a real new edge added along with its
allowlist line, which is the ordinary way a list grows. Measured: a genuine
`routes/export.ts -> backup-in-progress` import, duly listed, passed all six
assertions, and the list went 37 -> 36 -> 35 -> 36 -> 40 in a week while the
rule and the test's own comment both said it could only shrink. Adding an edge
now fails until someone raises the ceiling deliberately, and paying one off
fails until someone lowers it. ADR-0018's scheduled burn-down is complete;
the edges left belong to the unscheduled adapters, and paying one off lowers
the ceiling the same way.

`corrupt-stored-data` is excluded and says why: an error taxonomy an adapter
reads to pick a status code is translation, which is an adapter's job, and
listing it would put five permanently-unshrinkable entries in a list whose
whole value is that it shrinks.

**`ADAPTER_SCAN_EXEMPT_FILES`** carries by FILE what the wiring exemption —
a directory list (`di/`, `app.ts`, `http-server.ts`) — misses: a composition
root living inside an adapter tree. It is EMPTY today. It is separate from
`ADAPTERS_REACHING_MECHANICS` on purpose: an exemption is a CLASSIFICATION,
not debt, and a composition root's edges will never shrink.

## `mcp-server-layer-order.test.ts`: the layers inside the Node root

`web-layer-order.test.ts` pins that root's layers and has an emptied
ledger. `packages/mcp-server/src` had only ADR-0018's one-way scan, so a store
importing a route and `shared/` importing the server logger were both planted
(`store/names-store.ts`, `shared/sha256.ts`) and passed the whole project. The
order, bottom to top, is stated in the test's header and derived from how the
code is used: `shared` < `daemon` < `mechanics` (`server/{store,security,tenant,
export,search,observability,release}/**` plus the top-level `server/*.ts` that
are mechanisms) < `adapters` (`routes/`, `mcp/`, the helpers routes share) <
`composition` (`app.ts`, the HTTP roots, `di/`) < `entry` (`cli/`,
`server/stdio-root.ts` and its process entry `mcp/stdio.ts`). A module may
import its own layer or any below.

Top-level `server/*.ts` files are each NAMED in `TOP_LEVEL`, not guessed, so a
new one fails `belongs to no layer` until someone places it. The classifier is a
pure function over file contents, so the two planted cases are also fixture
tests that keep their teeth without planting.

One upward edge exists, ledgered with the move that retires it, count pinned
by equality: the membership gate reaching an adapter helper
(`security/membership-gate.ts -> workspace-handle.ts`). It was eight; the rest
were modules in the wrong directory and moved: the stdio root out of the
library the HTTP app composes (now `server/stdio-root.ts` beside
`mcp/server.ts`), the stream registry, audience and viewport cache to
`server/sync-streams.ts`, `sync-audience.ts` and `viewport-requests.ts`, the
scheduler to `store/auto-version.ts`, the fetch-model contract to
`shared/api-contracts/search-fetch-model.ts`, and the legacy trust-file purge
to `server/purge-legacy-trust-file.ts`. The eight were cross-checked against
an independent directory-level import matrix first. Type-only edges count, as
in the web guard.

## `route-portability.test.ts`: which routes could leave Node

Classifies every non-test file under `mcp-server/src/server/routes/**` as
`node-bound` (a Node builtin, a Node-only package, inversify, a `store/`,
`daemon/`, `di/` or `export/` module, a `security/*-store`, the data layout,
or anything `scanSourceForBoundaryViolations` flags except
loro-crdt) or `portable`. The portable files that sit in `mcp-server` are a
ledger held from both sides with a length pinned by equality, so it can only
fall: a new portable route fails as unlisted, a listed route that gained Node
(or was lifted into `server-core`) fails as stale. It exists because ADR-0052
assumed `createServer(deps)` held the keeper protocol and it holds `/api/v1`
only; whether to lift the portable routes is that ADR's open decision, and the
scan states the count without deciding anything.

**Two readings.** The class above is judged on a file's OWN imports, which is a
lower bound and was once the whole guard: `import 'node:fs'` planted in
`server/validators.ts`, imported by three of the "portable" routes, left it
18/18 green. Each ledgered file is therefore also classified over the
transitive closure of its VALUE imports (`route-closure.ts`, on
`value-import-closure.ts`'s walk; type-only edges are erased and not followed),
with three named cut seams — `log.ts`, `workspace-handle.ts`, `mcp/server.ts` — that a lift would
replace with a handed-in dependency. A seam must itself be Node-bound and be
reached by a ledgered file, or it is a fake cut. Each ledger entry states its
`role` (a `router` is a file that mounts `new Hono(`; about half the ledger
is middleware, helpers and registries) and its `blockedBy`, which is checked
against the closure, so Node arriving through a helper edits an entry instead of
passing. Three counts are pinned by equality in `CLOSURE_COUNTS` (clean files,
files held only by the seams, routers among those); the test holds the numbers
and ADR-0052 the decision they inform, so this file restates neither.

A closure over import specifiers alone says more are liftable once the seams
are cut than this does, because this counts an ambient `Buffer` (in `sync-streams.ts`,
reached through the audience registry, and in `security/timing-safe.ts`) the way
the direct class always has. `store/corrupt-stored-data` is entered, not called a
mechanic, for the reason `MECHANICS_NOT_SCANNED` gives. It owns its own matcher
on purpose and shares nothing with the mechanic check, so each can fail alone.
`NODE_ONLY_PACKAGES` is a short list; a Node-only package missing from it shows
up as an unlisted portable route.

## `adapter-process-global-check.ts`: an adapter is handed its data layout

A sibling of the mechanic check over the adapter trees and the wiring beside
them (`server/routes/**`, `mcp/**`, `export/**`, `search/**`, plus `app.ts`,
`shared-background-work.ts` and `workspace-handle.ts`; tests and `_test-*`
scaffolding skipped): it bans `getDataDir` and `SELF_HOST_TENANT_ID`, matched
as USES through `countNamedUses` (about 500 reads found by name, none by
regex), so an alias or a bracket access cannot walk past it. The first is a process global and the second the one
tenant a self-hosted keeper has, so a route reading either decides inside
itself which directory and which tenant it serves. `createApp` takes a
`dataLayout` (`tenant/data-layout-seam.ts`, built by `bootSelfHostDeps` for all
three roots) carrying `dataDir`, `tenantId` and the files and exports
directories, and the routes read that.

The seam is its OWN module, apart from `tenant/data-layout.ts` that implements
it, so an adapter can hold the contract without importing the mechanic that
joins directory names — which the mechanic scan would count.

`source-scan.ts`'s walk skips `node_modules`, `dist` and `tmp` (a Stryker run
that crashes leaves a sandbox copy of the source under `packages/*/tmp`, which
failed two one-place guards until the walk stopped reading it; the size
ledgers' `EXCLUDED_DIR_SEGMENTS` is a different list, over `src` only).
Comments and string bodies are stripped before matching, so prose naming
`getDataDir()` is not a read. The ledger lives in the test, as `adapter-di-import-check.test.ts`'s does: guarded
from both sides, size pinned, every entry carrying its reason. Its ledger is
empty: the stdio root's `getDataDir()` read lives in `server/stdio-root.ts`, a
composition root outside the scanned trees, and the export measurer and
exporter are keyed by `DataLayout.fontsDir`. `findCompositionGlobalReads` covers the layers that BUILD
stores: `di/**` (also banning `globalStoreScope`, the stores' default) and
`server/store/**`. Its both-sided, size-pinned ledger holds the reads that are
each the one place allowed to choose the data dir or tenant; a new
`getDataDir()` in either tree fails until it takes the `StoreScope` instead.

A second scan, `scope-default-calls.ts`, closes what name-matching cannot
see: the process directory also enters through a default parameter (`new
FileVersionStore()`, `getDoc(id, path)`). It derives, from the AST of
`store/`, every export with a trailing `scope = globalStoreScope` parameter
(constructors too) or an `options.scope ?? globalStoreScope` read, then
reports a call in that population or in the two HTTP roots that omits the
scope, an `undefined` passed for it, a bare reference to such a function, and
any naming of `globalStoreScope` or `storeScope(`. It matches by imported
NAME, so a local function of the same name is not read as one, and it does
not follow a function handed on by reference to code elsewhere; a property
KEY spelled like one reads as such a reference, a known false positive. Its ledger is
both-sided with a pinned size: `app.ts -> storeScope` (the one derivation)
and `workspace-handle.ts -> workspaceRegistry`; `stdioBackgroundWork` takes
the scope the stdio root booted. `store-scope` is in
`MECHANICS_NOT_SCANNED`: a router holding the `StoreScope` it is HANDED is
not reaching for a mechanic.

## `no-test-utils-in-production.test.ts` and `blob-identity-one-place.test.ts`

No non-test, non-bench, non-`_test-*`, non-`test-utils/` file under
`packages/*/src`, `apps/*/src` or `tools/*/src` imports a specifier with a
`test-utils` segment or a basename ending `-test-utils`: those barrels
re-export vitest-importing suites, and a built daemon bundle has carried an
in-memory store that way. Two allowlist entries, each with a reason, guarded
from both sides.

The same test also rejects a production import of a `_test-*` basename (a
type-only edge is erased and allowed) and runs the `test-framework-import`
scan over `mcp-server/src` and `apps/web/src` production files: three web
files that import vitest are ledgered from both sides.

`blob-identity-one-place.test.ts` keeps where a blob digest lives
(`tenant/data-layout.ts`), how a ref is keyed (`ports`' `blobRefKey`) and
sha-256-to-hex (`shared/sha256.ts`) to one spelling each in non-test
mcp-server source; a test that hand-spells a path is the oracle and is exempt.

## The spatial-codec registry scan

`repo-coverage.test.ts` checks one thing that is not a boundary: every
`*_PROJECTION` table declared under `packages/codec/src/spatial` is named in
that package's `codecs.ts`. It lives here rather than in codec because the
check has to READ that package's source, and codec's only in-package way to do
that is `import.meta.glob` — which needs `vite/client` in its `types` and would
drag the DOM lib into a shared-layer package whose tsconfig exists to keep it
out. This tool already reads every package's source textually.

What it is worth: a projection table nothing registers is a FORMAT that none of
codec's round-trip, confluence or loss-table guards are being asked of, which
reads exactly like a format that answered them. Mutation-checked both ways — an
unregistered third table fails it, and a scan whose pattern stops matching
fails the count test rather than silently reporting everything as registered.

## `brand-signature.test.ts`

BRAND.md says "Every brand surface renders this exact path" and nothing
checked it. The mark is copied into thirteen places across both
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
`.claude/skills/steward/reference/flake-shapes.md` prescribes under "A third
shape: `await import()` of a heavy module INSIDE a test body". The read count is pinned by its own assertion rather than
left to a reader, because the redundancy was invisible in the source and
visible only as a timeout somewhere else. Directory WALKS are still repeated
per word and deliberately so: deduping them saves 9ms of the 255, which does
not buy a second thing to keep true.

## `read-failure-as-absence.test.ts`

A file read (`readFile`/`readFileSync`) whose `catch` answers `null`,
`undefined`, `false`, `[]`, `{}` or a missing-ish `kind` — or nothing — without
mentioning `ENOENT` must be classified in its `LEDGER`, in one of five words
(`probe` / `fails-safe` / `degrades-visibly` / `deliberate` / `debt`) plus a
reason. Only ENOENT means "nothing is here"; any other failure says nothing,
and a caller that acts on the `null` can destroy what it could not read. That
is not hypothetical: the daemon identity and the macaroon root key were both
REPLACED on any read failure, which a secret at mode 0o000 reaches.

Narrow on purpose. The wider family — any failure answered as an absence —
was 328 production sites when measured, most of them right (platform probes,
user input), and a scan that cries wolf gets deleted. Mutation-checked four
ways, the fourth being the one that matters: reverting
`readSecretFileIfPresentSync` to answer `null` for any error fails it.

## `spatial-canvas-write-one-place.test.ts`: a canvas is reconciled, never resynced

`writeSpatialCanvas` and `writeSpatialCanvasInto` resync by omission — every
stored record the reader skipped is deleted, as an op that ships — so no
non-test source outside `packages/loro-adapter` may call them; a writer takes
`reconcileSpatialCanvas(doc, prev, next)` with the canvas it last published
as `prev`. The keeper's three writers (9a) and the web editor's whole-canvas
fallback and proposal adopt (10) were the instances.

## The pointer guards read prose, and a comment names no occasion

`comment-identifier-pointers.test.ts` and `comment-file-pointers.test.ts` read
source comments, `.claude/rules`, `.claude/skills` AND each package's README
with `apps/web`'s DESIGN.md and BRAND.md — the first sweep over those docs
found six identifiers and two file names that nothing resolves. Widening the
source-comment shape instead (any long camelCase name) would have needed a
ledger of about 70 foreign and historical names, a licence rather than a
decision per entry. `comment-chronology-phrases.test.ts` bans the phrases
that date a comment to the work that produced it (`audit-triage`, `dogfood
report`, `this PR`, "decision, this session", "this session's bug report");
bare `this session` is NOT banned because the app's own noun hits about 50
legitimate comments. Its ledger is empty and shrink-only.

## `classifyPath` and `countNamedUses`: what every guard answers once

"Is this file shipped or a test" is `classifyPath` in `source-scan.ts`
(`shipped | test | test-support | harness | bench | docs-snapshot`); a guard
states which categories it treats as shipped, and one that differs says why
in a line. Eleven local `isTestFile`/`isShipped` copies disagreed on 28 files
and hid three test-only exports. A one-place guard matches USES of a name
through `countNamedUses` (`named-use-scan.ts`), never a regex on its text, so
an alias or a bracket access cannot walk past it. A permission list
(`MECHANICS_NOT_SCANNED`, `MECHANIC_DIRS`, a vocabulary `exempt` array) is
guarded from both sides. Host reach counts a storage driver (`kysely`,
`libsql`, `@libsql/*`) and `node:process`: `process.env` reached through any
binding of `process`, a destructured `{ env }`, a string key,
`globalThis.process` or `env` imported from `node:process`. A nested
destructure or a parameter default is not seen.

`stripCommentsAndStrings` (`source-scan.ts`) is read off the TypeScript
parser, not a regex or a bare scanner: a scanner has no grammar, so one
interpolated template flipped every later backtick and a quote inside a regex
literal opened a string. It takes the `fileName` to pick the grammar (`.tsx`
reads `<T>x` as JSX) and is memoised per (file, source), because the parse
costs about 45 s over the tree under load against 1.9 s for the regex, and
every one-place guard calls it. `source-scan.test.ts` holds it on planted
cases, never on an oracle built from the code it judges.

## `scan-roots.ts` and `size-ledger-assertions.ts`: what scans share

`scan-roots.ts` owns `REPO_ROOT`, `workspaceDirs()` (every `packages/*`, `apps/*`
and `tools/*` directory with a manifest — three guards kept their own copy), the
size ledgers' `SCAN_ROOTS`, their `EXCLUDED_DIR_SEGMENTS` (full repo-relative
paths matched from the start, each of which must exist, so a moved directory
fails rather than silently un-excluding itself) and the one
`walk(dir, { include, skip })`; a scan
passes its FILTER and gets the traversal. Two of its choices are measured, not
tidy: `skip` is judged before the entry is stat'ed, so it reaches FILES (a
nested worktree's `.git` is a file), and `isExcludedPath` matches the path
RELATIVE to the repo — this checkout may itself live under
`.claude/worktrees/`, where an absolute match excludes every file in it.

`size-ledger-assertions.ts` registers the five assertions every shrink-only
size ledger makes (unlisted, grown, shrunk, missing, headroom). The titles and
the message for each stay at the call site, because a file and a function are
closed differently; what is shared is the judgement. A population-size floor
and a cross-ledger check stay at the call site too, since what counts as a
plausible population is the caller's subject.
