# ADR-0052: The edge keeper — a personal workspace on Cloudflare Workers, built as a third composition root

**Status:** Accepted, decided by the owner on 2026-09-28. Nothing is built
yet; the slices below are the plan. It carries out
[ADR-0044](0044-workspace-capacity.md)'s second 2026-09-22 addendum, which
adopted a Worker keeper for personal workspaces, and it settles the questions
that addendum left open: where the code lives, which runtimes are supported,
how tenancy is bounded, and who may reach it.

## Context

ADR-0044 decided that a keeper on Cloudflare's Durable Objects is worth
building for one person's workspace. A 128 MB isolate holds a few hundred
documents, which is enough for a personal workspace. A shared or large
workspace belongs on a daemon or a self-hosted keeper. Before building it,
the owner asked for two things to be settled first:

- the LICENSING;
- where the CODE LIVES.

They also asked for self-hosting on Cloudflare's own open-source runtime,
workerd, to be weighed as an alternative. Two readings informed the answer.

**What the codebase already carries.** The shared layer is meant to run
unchanged on Node, the browser and Workers, and the architecture map's scans
hold it to that. `packages/server-core`'s `createServer(deps)` holds every
`/api/v1` route and every MCP tool. It depends on `hono`, `zod` and
`loro-crdt` only, so it is already portable. A new keeper therefore builds a
`ServerDeps` rather than reimplementing routes
(`packages/server-core/src/server-deps.ts`). What lives only in
`packages/mcp-server`, the Node composition root, must be replaced for a
Worker:

- the libSQL document store;
- the filesystem blob and version stores;
- the Inversify wiring;
- the background-work registry;
- the sign-in routes (ADR-0045/0046);
- the served web app (ADR-0047).

**What the ecosystem says** (surveyed 2026-09-28, sources in the PR that
lands this ADR):

- **Licences.** workerd is Apache-2.0. wrangler, Miniflare,
  `@cloudflare/workers-types` and `@cloudflare/vitest-pool-workers` are MIT or
  dual MIT/Apache-2.0. `loro-crdt` is MIT. All are compatible with this
  Apache-2.0 repository as dependencies, as build tools, or bundled.
- **Trademark.** Cloudflare's guidelines forbid using its marks as part of a
  product or application name, and allow them only in a referential phrase
  ("for Cloudflare Workers"). "Cloudflare Workers" is a registered mark.
- **Self-hosted workerd.** It runs Durable Objects, but its on-disk storage
  backend is documented as `EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE
  CHANGE`, and objects "are always local to one instance of the runtime". No
  isolate memory limit is enforced outside the hosted platform. No completed
  experiment was found that shows Durable Object storage surviving a restart
  of a self-hosted instance, and no named production user was found.
- **Hosted Durable Objects.** They run on the Workers free plan, store up to
  1 GB per object on the free plan and 10 GB on the paid plan, and allow a
  64 MiB script. The 128 MB memory ceiling is unchanged, and the limits
  page should be re-read at build time.
- **Prior art.** tldraw keeps its Cloudflare sync backend inside its own
  monorepo. y-durableobjects and PartyKit are MIT wrappers over Durable
  Objects.

## Decision

### 1. It lives in this monorepo as `apps/edge-keeper`, a third composition root

It is registered in the architecture map the way `mcp-server` and `apps/web`
are:

- it is never imported by a shared package, which the direction check
  enforces;
- its own manifest is direction-checked;
- it ships its path-scoped rule `.claude/rules/package-edge-keeper.md` in the
  increment that creates it.

It is **private and deployed, never published**, so "only
`@kamiazya/whiteboard-mcp` publishes" stands.

A separate repository was rejected because this keeper consumes eight to
eleven private packages, and publishing them is a policy change nothing else
asks for. An adapter inside `mcp-server` was rejected because that package
is the one place `node:*` is allowed, and it is what npm ships.

**Names avoid the marks.** Neither the directory, the package name nor any UI
label fuses "Cloudflare", "Workers" or "Durable Objects". Prose says what it
runs on ("the edge keeper, for Cloudflare Workers").

### 2. Hosted Cloudflare is the supported target; the Node container stays the supported self-host

The code is written to the runtime's standard API, so nothing in it prevents
running it on workerd. **Self-hosted workerd is not a supported deployment**,
though, and documentation may describe it only as experimental. The reason
is its storage: it is labelled experimental by its author, it is
single-instance, and its persistence across a restart is unverified.

[ADR-0020](0020-coordination-boundary.md)'s one-container Node self-host
remains what an operator runs on their own machine. This is revisited only
after a measurement shows a self-hosted workerd instance keeping a
workspace across a restart.

### 3. One Durable Object per workspace; tenancy is the object boundary

A request reaches exactly the object its workspace id names. So there is no
query surface that could cross from one workspace into another, and the
`tenantId`-column discipline ADR-0044's addendum flagged is not needed
inside this keeper.

ADR-0020's fencing machinery is not needed within an object either: one
object is one linearizable actor. Accounts, billing and any list of
workspaces sit OUTSIDE the object, in the Worker's routing layer. Nothing
about them is decided here.

### 4. Access is the server-mode sign-in, ported: OIDC and the keeper-served web app

The edge keeper serves the web build from its own origin and signs a person
in through OIDC, as [ADR-0046](0046-external-sign-in.md) and
[ADR-0047](0047-server-mode-web-app.md) do for server mode. It has one
person, not a user list.

This is chosen over a single shared token and over Cloudflare Access for one
load-bearing reason: **ADR-0044 decision 4 requires a way in**. That way in
is the cross-origin transfer, whose receiving page runs in the
keeper-served web app and authorises the merge with the signed-in person's
session (PR #1985). A keeper reachable only by a bearer token could not
receive a transfer. A keeper behind Access would tie access to one vendor's
product and leave the workerd path with none.

Consequence: the sign-in and session code that lives in
`packages/mcp-server/src/server` today must be lifted into a runtime-neutral
shared package before this keeper can use it. That covers:

- the OIDC relying party;
- the session store port;
- the host-only cookie;
- the admission function.

That extraction is its own slice, and it is also an improvement for server
mode.

### 5. It declares its capacity, measured on the runtime that enforces it

The edge keeper is the backend ADR-0044 was written for. It declares its
limit and promotion band the way the browser keeper does
(`apps/web/src/lib/browser-keeper-capacity.ts`), under the "one more full
export still fits" criterion. Two measurements feed the number, and neither
one is enough by itself:

- **The curve**, taken locally with Miniflare or workerd running the real
  record: how peak memory grows with the document count.
- **The ceiling**, calibrated on HOSTED Cloudflare. The 128 MB limit belongs
  to the isolate, not to one object, and several Durable Objects can be
  co-resident in one isolate and share it. Self-hosted workerd enforces no
  limit at all. So a single workspace measured alone locally overstates what
  one workspace may use. The declared limit has to leave headroom for
  co-resident objects, and that headroom is measured on the hosted platform
  with several objects loaded, not assumed.

**The refusal happens BEFORE the allocation, never at it.** An isolate that
runs out of memory is killed, not handed a catchable error, so an
allocation failure cannot be the mechanism that says "too large". The
keeper refuses by document count at admission, the way the browser keeper
does, so the write is turned away with its reason before it grows the
record.

Until the hosted calibration exists, that count is a conservative
PROVISIONAL limit, taken from the local curve with room to spare. Pick the
largest count whose local peak, plus one more full export, stays under
HALF the isolate, since a co-resident object may hold the other half. It
is raised only by the calibration.

## Consequences

### What becomes easier

- A personal workspace can live somewhere reachable from any device, with
  no machine of the person's own running.
- `server-core`'s portability claim gets a real second runtime. Until now it
  was checked by scans, not by a deployment.

### What becomes harder

- **Three composition roots.** Each port gains a third implementation to
  keep conformant. The existing conformance suites
  (`describeDocumentStoreConformance`, `describeBlobStoreConformance`) are
  what make that affordable, and every new store must pass them.
- **Background work.** Backups, garbage collection and version checkpoints
  are process-lifetime ideas in `background-work.ts`. A Durable Object has
  alarms instead, and each worker must be designed afresh rather than
  ported.
- **The auth extraction.** It touches server mode's security code. It lands
  with server mode's existing tests unchanged and green.

### What this ADR does NOT decide

- A hosted offering that fronts many people's objects: accounts, billing,
  a directory of workspaces.
- Whether a shared or large workspace ever runs here. ADR-0044's scope
  line keeps those on a daemon or a self-hosted keeper.
- The capacity numbers. They are decision 5's measurement.

## Plan

In dependency order. Each slice lands on its own with its verification.

1. **Stores.** A `DocumentStore` and a `BlobStore` over Durable Object
   storage in `apps/edge-keeper`, passing the ports' conformance suites under
   Miniflare, with no deployment.
2. **The architecture-map entry, rule file and CI job**, with a reverse
   import planted and refused before it is removed.
3. **`ServerDeps` in a Durable Object.** One object per workspace, with
   `createServer(deps).app.fetch` answering `/api/v1`. An integration test
   shows two workspaces landing in two objects and not seeing each other.
4. **The sign-in extraction** into a shared package. Server mode's suites
   stay unchanged.
5. **Sign-in and the served web app** on the edge keeper.
6. **Capacity** per decision 5. Declare the provisional limit from the
   local curve and refuse at admission, before any allocation. Then
   calibrate the ceiling on hosted Cloudflare with co-resident objects,
   and only then raise it.
7. **The way in.** A transfer from the browser keeper is received and
   merged, end to end. It extends `pnpm smoke:transfer`.
8. **Deployment and docs.** `wrangler deploy` from CI to a staging object,
   and a how-to that states self-hosted workerd is experimental.

## Alternatives considered

- **A separate repository.** It would isolate the licence, but nothing
  needed isolating: every dependency is Apache-2.0- or MIT-compatible. It
  also forces publishing the shared packages.
- **Self-hosted workerd as a supported target.** Rejected for now, for
  decision 2's reasons: experimental storage, a single instance, no memory
  ceiling, and persistence across a restart that is unverified. The Node
  container already does that job with none of those caveats.
- **One shared token, or Cloudflare Access.** Rejected for decision 4's
  reason: the keeper would have no way in for a transfer. Access would also
  bind the workerd path to nothing.
- **One object per account holding several workspaces.** Rejected because
  it reintroduces the tenant-column discipline inside the object and
  multiplies the memory a single isolate must hold. That memory is exactly
  what ADR-0044 measured as the binding constraint.

## Correction note (2026-10-02): the keeper protocol is not in `server-core`

Context says `createServer(deps)` "holds every `/api/v1` route and every MCP
tool" and that a new keeper "builds a `ServerDeps` rather than reimplementing
routes". That is true of `/api/v1` and of the MCP tools, and of nothing else.
`createServer` mounts `/api/v1` only. The routes the web app speaks to a keeper
live in `packages/mcp-server/src/server/routes/`, and the list of what "lives
only in `mcp-server`" above leaves every one of them out. Plan slice 3 serves
`/api/v1` from a Durable Object, so on its own it would not serve the sync
protocol a browser needs to talk to that object.

What the web app depends on that is not in `server-core`, classified by
`tools/arch-lint/src/route-portability.test.ts` from each file's own imports,
as measured on 2026-10-02:

| route file | what it carries | class |
|---|---|---|
| `sync-sse.ts` (router) | `/api/sync/stream`, `/subscribe`, `/message` | portable by its own imports; transitively held by both seams and a `Buffer` global in `sync-streams.ts` |
| `document/workspace-document.ts` | workspace-document snapshot and update | node-bound, only by a `Buffer` global |
| `document/workspaces.ts` (router) | `/api/workspaces`: list, create, rename, a workspace's documents | portable by its own imports; transitively held by both seams and `node:os` in `document/_shared.ts` |
| `document/trash.ts` (router) | the trash list and restore | portable by its own imports; transitively held by both seams only |
| `document/live-doc.ts` (router) | a document's snapshot, existence and update by path | portable by its own imports; transitively held by the `workspace-handle.ts` seam only |
| `document/restore.ts` (router) | a document's restore | portable by its own imports; transitively held by the `workspace-handle.ts` seam and `node:os` in `document/_shared.ts` |
| `document/path-route.ts` (helper) | the path helper those routers share | portable by its own imports; held by the `workspace-handle.ts` seam only |
| `status.ts` (router) | an operations probe no web page calls | portable by its own imports; transitively held by both seams and a `Buffer` global in `sync-streams.ts` |
| `workspace-people.ts` (router) | a workspace's members | portable by its own imports; transitively held by both seams and a `Buffer` global in `sync-streams.ts` |
| `mcp.ts` (router) | the `/mcp` endpoint | portable by its own imports; transitively held by the `log.ts` and `mcp/server.ts` seams and a `process` global in `app-helpers.ts` |
| `auth.ts` (middleware) | the bearer gate | portable by its own imports; transitively held by both seams, `node:crypto` and a `Buffer` global in `security/timing-safe.ts` |
| `body-limit.ts`, `document-output-path-error.ts` (helpers) | two small helpers | portable, and clean over their transitive imports |
| `document/metadata.ts` | workspace and document names | node-bound: `store/names-store` |
| `document/maintenance.ts`, `document/versions.ts`, `document.ts` | version pruning, optimisation, history | node-bound: `store/document-store`, `store/version-store`, `store/auto-version` |
| `files.ts` | file purge and the file routes | node-bound: `node:fs`, `store/` |
| `export.ts`, `document/export-svg.ts`, `fonts.ts` | headless export and installed fonts | node-bound: `node:fs`, `export/` |
| `runtime-storage.ts`, `document/_shared.ts`, `runtime.ts`, `debug.ts` | daemon storage and runtime reports | node-bound: `node:*`, `store/` |
| `invitation-link.ts`, `tenant-people.ts`, `replica-key.ts`, `sign-in.ts` | invitations, a tenant's people, the replica posture, OIDC sign-in | node-bound: `security/*-store`, and `@hono/node-server/conninfo` for `sign-in.ts` |

"Portable" in the first sense is a statement about a file's OWN imports: hono,
the contracts and the seams it is handed. That is the lower bound, not a
promise, and it was the only reading the first version of the guard took — a
`node:fs` planted in `validators.ts`, which three of these import, left it
green. The guard now also walks each file's transitive VALUE imports (type-only
edges are erased at emit) with three named cut seams, `log.ts` (the Node
logger), `workspace-handle.ts` (which reads the store's workspace registry
through a module-level handle, a ledgered edge in `adapter-mechanic-check`) and
`mcp/server.ts` (the `McpServer` factory over the widget bundle on disk), that a
lift would replace with a handed-in dependency. Of the twelve files, eight are
routers (they mount a Hono app); the other four are the bearer gate and three
helpers, which sit in `routes/` and are not routes.

Counted that way, as measured on 2026-10-02: **two** of the twelve are clean as
they stand (`body-limit.ts`, `document-output-path-error.ts`, neither a router),
**five** are held only by the cut seams, and **two** of the eight routers
(`live-doc`, `trash`) are among those. The rest carry a named blocker: `node:os`
in `document/_shared.ts` (`restore`, `workspaces`), `node:crypto` and a `Buffer`
in `security/timing-safe.ts` (`auth`), a `process` global in `app-helpers.ts`
(`mcp`), and a `Buffer` global in `sync-streams.ts`, which `sync-sse`, `status`
and `workspace-people` reach through the stream registry. The direct class has
always counted an ambient `Buffer` as Node (it is why `workspace-document.ts` is
node-bound), and the same base64 helper that clears that one clears
`sync-streams.ts` too.

The twelve portable files, the role of each and what holds it are listed in the
test, which holds that list from both sides, checks each file's blockers
against the closure and pins its length and the three counts so they can only
fall: a portable route added to `mcp-server` fails the build until the ceiling
is raised on the record, and one lifted into `server-core` fails it until the
ceiling is lowered. The same test reads this note, so the twelve names, the
three counts and the seam list above cannot drift from the ledger unseen.

**Whether to lift the seam-only routes into `server-core` is an OPEN DECISION
for the maintainer, and nothing here makes it.** The alternatives are:

- lift the portable routes as they are, and the `Buffer` pair after a base64
  helper, so a Worker keeper mounts the same sync protocol through
  `createServer(deps)` and the claim in Context becomes true of the protocol
  too;
- or let the edge keeper serve a protocol of its own, which makes ADR-0018's
  divergence a deliberate property of this keeper rather than an accident.

The store-bound routes need a seam before either move, which is ADR-0018's work
and not this note's. Until this is decided, treat slice 3 as serving `/api/v1`
only.
