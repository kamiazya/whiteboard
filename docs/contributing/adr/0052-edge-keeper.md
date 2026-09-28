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

Until that calibration exists, a real allocation failure is the backstop.
It must surface as a refused write with a reason, not as a dead isolate.

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
6. **Capacity** per decision 5. Measure the curve locally, calibrate the
   ceiling on hosted Cloudflare with co-resident objects, then declare.
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
