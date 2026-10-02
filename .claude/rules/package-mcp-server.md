---
paths:
  - "packages/mcp-server/**"
---

# mcp-server — the Node composition root (CLI, daemon, stdio, local stores)

Placement and boundaries are `architecture-map.md`'s (a composition root:
allowed `node:*`, DOM-free, inversify; never imported by a shared package).
This file carries what a session editing the daemon has to know that no
scan says.

## Tests

- **Repo-policy guards are not tests of this package.** A test that reads
  workflows, the Dockerfile, root manifests, docs or the rule corpus and
  imports no daemon source lives in `tools/arch-lint/src` — the project
  pre-push runs — not under `server/` or `server/release/`. `release/` keeps
  only what needs the daemon, the packages' fast-check prelude, this package's
  own scripts, or the Node it runs on, and
  `tools/arch-lint/src/repo-root-reads.test.ts` fails on a new one added here
  without a reason.
- **Every HTTP route the daemon registers is fuzzed from its own schema**
  (`server/app.routes.fuzz.property.test.ts`), the sibling of server-core's
  `/api/v1` lane over everything else `createApp` mounts. Routes are read
  off `app.routes`; the three wildcard patterns dispatch on the URL's tail,
  so their actions are read off the `onDocumentAction` /
  `onDocumentFile` / `onDocumentsRoute` calls in the routes directory and
  expanded — a route added without a rule fails the ledger, and a rule
  without a route fails it the other way. A route may answer (2xx, 204 for
  a store, 501 when the composition lacks the feature) or refuse with a
  JSON reason (4xx, and 503 for "no browser is connected"); a 5xx or a
  plain-text body is a failure. `refusesOnly:` names why the seed cannot
  reach a route (sync needs an open stream, a fresh data dir has no
  installed font) and is checked to stay
  true; `skip:` names why a route is not requested (the SSE stream holds
  the response open, font install reaches the network, RFC 9728 discovery
  answers a bare 404 by design).
  A rule may also name the `response` schema the web client reads that
  route's answer with (daemon-client's `api-contracts`), and every 2xx is
  parsed under it: the handlers are typed, but nothing parses on the way
  out, so a field the route emits and the contract lacks — or the reverse
  — is drift only a reader would find.
- **Its seed composes the app the way production does, and the reason is a
  trap.** A container over the in-memory module gives an app whose
  `/api/v1` and legacy `/api/workspaces` routes look at different worlds — a
  document created through one is invisible to the other, and a lane seeded
  that way reports every legacy route as refusing. The lane builds
  `serverDeps` from `createStoreLocalModule` over the same data dir the
  module-level document store reads. Each seeded app
  also gets its OWN workspace handle and data dir: the document store is
  module-level and keyed by workspace, and a checkpoint a previous app
  scheduled can land after its test ended — under a reused handle it wrote
  the previous seed's documents into the next seed's fresh database
  (measured: `Document path "board" already exists`, one run in three).
- What the lane found the day it was written, each fixed with an example
  test beside it: a document update whose bytes Loro cannot decode escaped
  the handler as a thrown decode error (now 400 `invalid_body`, checked
  with `decodeImportBlobMeta` before the import, as the workspace-document
  route already did); an export `scale` the schema admitted but that sized
  the render to nothing answered 500 `headless_export_failed` (the schema
  now bounds `scale`/`padding`, and the renderer's zero-size
  refusal maps to 400); a missing file answered Hono's plain-text 404 (now
  JSON `not_found`); an empty upload stored a zero-byte file (now 400
  `empty_body`); and creating a document under a handle that passes the id
  validator but cannot be a workspace SEGMENT (`-`) answered 500 "Failed to
  create canvas." — the mint boundary's `WorkspaceSegmentUnusableError`,
  which the handler's own comment promised as a 400, fell through its
  catch-all (now mapped).
- **Every JSON this package writes and reads back is round-tripped from its
  schema** (`server/persisted-json.property.test.ts`): the server-mode and
  daemon records, the database location record,
  the backup-in-progress marker, the blob envelope, the mirror manifest, and
  the backup result the scheduled pass reads off the CLI's stdout. Each is
  declared once and read through Zod, so the SHAPES cannot drift; what the
  lane is for is a value the writer produces that a runtime check refuses,
  because every reader here fails soft — an empty store, `null`, "no backup
  running" — and the loss is silent. It found one the day it was written:
  the marker's `expiresAt` was `Date.now() + ttlMs` under a schema that says
  `.int()`, so a fractional lifetime wrote a marker GC read as no backup at
  all, for the whole pass (now rounded up). The property's own bound has to
  round the same way, or it fails on the fix.
- **A stored shape added tomorrow has to answer for itself**
  (`server/persisted-json-surface.test.ts`). The lane above lists its
  subjects as imports, so it could not notice a tenth writer/reader pair —
  the route lanes read `app.routes` and scan the routes directory, and the
  store lane did not. The ledger scans every place a Zod schema is handed
  `JSON.parse` output, and each is `round-tripped: <the lane's describe>` or
  `not modelled: <what covers it instead>`. Both directions fail, and the
  round-tripped side names a TITLE rather than a module on purpose: "the lane
  imports this file" is satisfied by an incidental import, which is how the
  browser twin's first version could not fail at all.
- **A route refuses in JSON, and `c.notFound()` does not**
  (`tools/biome-plugins/route-refusal-shapes.grit`, scoped to
  `server/routes/**`). Hono's built-in 404 answers `text/plain`, so a caller
  parsing the body gets a SyntaxError instead of the reason — the shape the
  files router shipped until the fuzz lane found it. The lint rule is the
  rung that stops a new one being written; it caught one live instance, the
  disabled `/api/debug` router. It is scoped to `routes/` because
  `c.notFound()` is CORRECT three times in `app.ts`: RFC 9728 discovery
  answers a bare 404 by design, and the two UI catch-alls serve a browser.

## The export reads the workspace's tag library (ADR-0040 decision 5)

`export/headless-export.ts`'s `libraryFor` hands `renderSpatialCanvasTo{Png,Svg}`
the document at `tags` as `HeadlessExportOptions.tagLibrary`, so `/export`
and `/export-svg` draw the picture `wb_scene_render` draws: a box or an edge
carrying a declared value and no colour of its own in that colour, the
legend naming the key. Two guards, each held by an example and
mutation-checked: it asks only for a board that CARRIES a tag
(`carriesATag`, server-core's), so the common untagged board costs no
read; and it probes `documentExists` before `getDoc`, because the headless
read path answers a missing path with an EMPTY document it then keeps —
without the probe every export of every workspace would mint a `tags`
document. `headless-renderer.tag-library.test.ts` holds the threading
through the real renderer, since the export test mocks it.

## Background work is declared before it is armed

**Work the daemon does on its own is declared before it is armed.**
`packages/mcp-server/src/server/background-work.ts` is the registry, and the
composition roots start and stop everything through it. Adding a scheduler, a
sweeper, a poller, or a dispatcher means editing that file and answering three
questions the diff would otherwise never ask:

- **who runs it** when several instances share one record — `leader-only`
  (naming the lease) or `every-instance` (saying why that is right, since it
  is also what a worker gets by accident);
- **what it costs the serving loop** — `subprocess`, or `in-process` with a
  `stallCeilingMs` **a test asserts on every run**, taken with
  `shared/test-utils/loop-availability.ts` rather than by hand;
- **what triggers it**.

Both of the first two were got wrong on one worker, invisibly. The backup pass
ran on every instance (N backups a night, and N retention passes each deleting
from a set the others were changing) and inside the serving process, where
`VACUUM INTO` blocks the event loop for its whole duration — 1242ms at a 103MB
database, 4767ms at 421MB, and rising with the data. Nothing in the source says
a call blocks: an `await` on a native binding reads exactly like an `await` on a
socket. `snapshot-blocking.test.ts` pins that one so the decision that put a
subprocess in the way fails loudly if the call ever stops blocking.

A ceiling rather than a reading, because a reading goes stale in silence. The
field first held `0` on three declarations, each with a date and no
measurement behind it. Naming the source test in a `fixture` string was meant
to fix that and did not: the workspace tail then declared 283ms while citing a
test that measures 20-29ms — the number came from a scratch script at a larger
fixture, and the citation was written from memory. **A number with a source
named beside it is still unbacked if nothing reads the source.** So the
declarations live in `background-work-costs.ts` where a test can import them,
each loop-availability test asserts its own measurement stays under its
ceiling, and `background-work-costs.test.ts` fails on a declared ceiling no
test asserts — with an exemption list guarded from both sides, for the one
worker (`idle-shutdown`) that compares two timestamps and has no call to
measure. Larger hand-measured points stay in `fixture`, said plainly to be
hand measurements: they are what a reader sizing a deployment needs and
exactly what a test on a small fixture cannot check.

The instrument itself is calibrated against known truths in
`loop-availability.test.ts`, which is not ceremony — it was written, trusted
for three declarations, and only calibrated after the fact, at which point
`worstStallMs` turned out to report **0.3ms for a 200ms stall** whenever the
stall ran to the end of the body.

The registry is load-bearing rather than advisory — an undeclared worker does
not typecheck, and `background-work.guard.test.ts` fails on a `.start()` in a
composition root that goes around it. What it does NOT catch is a worker that
arms itself at module load or from somewhere else; that is what this paragraph
is for, and prose is the weaker rung on purpose. The registry earned its keep
on the first read: `server-mode-http.ts` — the MULTI-INSTANCE root, the one the
backup lease was built for — was starting no background work at all, so
scheduled backups reached only the local daemon.

## How the HTTP roots arm their work, trace, and document their env

Each HTTP root takes its workers from `createSharedWorkers` whole: `fileGc` (the
sweeper with its capped stop) and `checkpoints` (the holder for the scheduler
`createApp` hands back) are carried on `SharedWorkers`, and
`composition-roots.guard.test.ts` fails a root that hand-builds either.
`background-work.guard.test.ts` accepts a worker wrapped as
`start: () => x.start()` in the shared set, since it arms nothing until the
registry calls it, and still fails a direct `x.start()` outside a registry call.

Tracing is started by each HTTP root (`startHttpRootTracing` in
`observability/root-tracing.ts`), not by a process entry:
`whiteboard daemon run` and `whiteboard server run` never reach the dev entry's
`main()`. The headless-exporter pre-warm is dev-entry only on purpose: it is
one-shot (~40-60ms stall, 150-220ms wall) and is not registry work.

`env-docs-contract.test.ts` reads `envFlag('…')` and `env.OTEL_*` as well as
`env.WHITEBOARD_*` and `env.MCP_*`, so a new variable of any of those shapes
needs its documentation in the same increment.

## A store follows the directory it is handed

**Through a `StoreScope`.** `bootSelfHostDeps(dataDir)` builds the document
store, blob store and index over `dataDir`; the seams beside them (live
documents, workspace documents, versions, teardown, the write signal) and the
doc and workspace-doc caches under them follow the same `StoreScope`
(`server/store/store-scope.ts`), which the store module binds under
`STORE_SCOPE`. Functions in `store/` take a trailing `scope` defaulting to
`globalStoreScope` (the process's data dir, read lazily), so routers and
workers with no composition are unchanged. `boot-self-host-deps.test.ts` is
the executable half: it boots over one dir while `getDataDir()` names another
and asserts the other stays empty. What still follows the process dir is
listed in `bootSelfHostDeps`'s doc comment.

**`createContainer(storeModule)` takes its module; the in-memory one is a
test double at `shared/test-utils/store-memory.module.ts`.** There is no
default, and `no-test-utils-in-production.test.ts` plus
`no-production-wiring.test.ts` (which scans `di/**`) fail on a production file
importing a `test-utils` module.

**Where a blob digest sits on disk is `tenant/data-layout.ts`'s
`blobShardPath` / `parseBlobShard`, and a `BlobRef`'s map key is `ports`'
`blobRefKey`.** `tools/arch-lint/src/blob-identity-one-place.test.ts` bans
re-spelling either — digest slicing, the shard and digest regexes, and inline
sha-256-to-hex outside `shared/sha256.ts` — in non-test mcp-server source;
tests that hand-spell a path are the independent oracle and are exempt.

## Log redaction

The root pino instance in `log.ts` redacts a fixed list of field names —
top-level (`token`, `daemonToken`, `bootstrapToken`, `accessToken`,
`authorization`, `cookie`, `password`, `secret`, `apiKey`) and one level of
nesting under any key (`*.token`, `*.daemonToken`, …) — replacing the value
with `[redacted]` before the record reaches stderr, an MCP
`notifications/message` subscriber, or a test capture sink. This is what
stops a call site that carelessly logs a whole request/client/config object
(e.g. `log.error({ client }, 'request failed')`) from leaking the daemon
bearer token or an OAuth access token.

Adding a new secret-bearing field anywhere in the server means adding both
its top-level and its `*.<name>` path to `REDACTED_PATHS` in `log.ts` — pino
redaction does not infer field names, and `fast-redact` has no
arbitrary-depth wildcard, so a secret nested two or more levels deep under
an unlisted key is not caught. The safer habit is still to never log a
secret-bearing object wholesale in the first place; redaction is the net,
not the plan. Redaction also cannot help when a secret is interpolated
directly into a message *string* (e.g. `` log.info(`token=${token}`) ``)
rather than passed as a structured field — do not do that.
