# ADR-0053: A workspace segment is unique within its owner's namespace, not across the keeper

**Status:** Proposed, 2026-10-17. The owner decided the direction that day —
"namespace segments per owner", design first, nothing implemented. This
record sets out the options against the code as it stands and recommends
one. The decision itself, and the open questions at the end, are the
owner's to settle.

Amends [ADR-0019](0019-workspace-identity.md)'s user-facing layer, which
says a segment is "unique per keeper".

## Context

### What a segment is today

ADR-0019 gave a workspace three layers: a canonical `workspaceId` (a ULID),
a `segment` (short, URL-safe, renameable, "unique per keeper"), and a
`displayName` (free text). The segment is what a person reads in
`/w/<segment>/d/<path>`.

**How one is minted.** Both keepers use the same two steps:

- `deriveWorkspaceSegment` (`model`) lowercases the display name and
  collapses each run of other characters to one hyphen. If the result does
  not pass `workspaceSegmentSchema`, it answers `undefined`.
- `firstFreeSegment` (`workspace-index`) takes that base and tries `base`,
  then `base-2`, `base-3` and so on, until its `isTaken` callback says a
  candidate is free.

`workspaceSegmentSchema` (`model`, next to `workspaceCanonicalIdSchema`)
checks shape only: the document-path charset, at most 200 characters, and
never ULID-shaped. The ULID rule exists because an address carries EITHER
a segment or a canonical id in the same position. Uniqueness is left to
each keeper's registry, and the comment says so. On the daemon, that
registry is the `workspaces` table's `workspaces_segment_unique` index from
migration `0018-workspace-segment`. The index is on `segment` ALONE.
Migration `0031-tenants` later gave the table a `tenantId` column but left
the index as it was, so the index is keeper-wide, across every tenant (see
"A latent second instance" below).

**How one is resolved.** `resolveWorkspaceHandle` (`ports`, beside the
`DocumentIndex` port) is the one precedence rule: the segment first, then
the canonical id, otherwise null. It works over whatever entry list it is
given. On the daemon that list is always the WHOLE registry:

- `resolveWorkspaceHandleToId` and `workspaceIdFromHandle` (mcp-server's
  `workspace-handle` module) call `workspaceRegistry().listWorkspaces()`.
  They resolve once per request, before any membership check.
- `membershipRefusalFor` (the `membership-gate` module) first resolves the
  handle against that list, then asks `workspaceAccess`.
- `workspaceAccess` answers the same `not_a_member` for a workspace the
  caller is not in and for an id that matches nothing. So a READ through
  the gate learns nothing about which workspaces exist. The leak is in the
  writes that mint or rename a segment, listed below.
- `withResolvedWorkspaceHandles` (`server-core`'s `workspace-handle`
  module) resolves the MCP `workspaceId` argument the same way, through
  `DocumentIndex.resolveWorkspace`.

In the web app, the daemon index page calls `resolveWorkspaceHandle` on
the list `GET /api/workspaces` returned. Server mode filters that list
through `admit`, so the CLIENT already resolves only within what the
caller can see. The SERVER does not.

**Where a segment appears.**

- **Web app URLs.** `workspacePath`, `documentPath` and
  `parseWorkspaceRoute` (the web app's `app-routes` module) define one
  grammar, `/w/<handle>` and `/w/<handle>/d/<path>`, for every keeper.
  `workspaceHandle` (the web app's `workspace-handle` module) chooses what
  to emit: the segment if there is one, otherwise the id.
- **API routes.** The `/api/w/:handle/…` and `/api/workspaces/:handle…`
  families (both patterns are in the `route-scope-registry` module) and
  the SSE sync target carry the handle.
- **MCP.** Every tool's `workspaceId` argument is a handle, typed as
  `workspaceIdSchema`, which is `[a-zA-Z0-9_-]+` with no `/`.
  `wb_workspace_edit`'s `createWorkspace: true` turns the handle it was
  given into the new workspace's segment.
- **The operator command line.** `whiteboard server grant-member
  --workspace=<workspace segment or id>`, and the daemon's
  `set-replica-tier` and `rotate-replica-key --workspace=<id|segment>`.
- **User docs.** `docs/explanation/domain-model.md` explains the three
  names and `/w/<workspace>`.

**Share links do not exist yet.** The document menu leaves out "Copy link"
on purpose: its comment says that "sharing returns when it is designed
against the keeper that has to honour it". The links a server-mode keeper
does hand out today are invitation links (`invitePageUrl`). They carry a
token, not a segment. So the only links that carry a segment today are the
ones a person copies out of the address bar.

### The oracle

On server mode, where workspaces are members-only (ADR-0046 decision 10),
a signed-in person can find out whether a workspace they cannot see
exists, by name. There are three paths, all as of `f1bd8f1c`:

1. **Rename** (`PATCH /api/workspaces/:workspaceId` in the daemon's
   `workspaces` router, lines 267-294). The gate admits the caller to their
   OWN workspace. `renameWorkspace` then hits the keeper-wide unique index.
   `segmentTaken` maps `WorkspaceSegmentTakenError` to **409 `Workspace
   segment "<s>" is already taken`**. A free segment answers 200. The test
   is exact and repeatable, and renaming back undoes it.
2. **Create** (`POST /api/workspaces`, lines 235-260, through
   `createWorkspaceRow`, lines 159-175). `firstFreeSegment` runs against
   `taken`, the full `listWorkspaces()` set. The `201` body then reports
   `segment: "design-2"` when somebody else holds `design`. The suffix is
   the answer. Each probe leaves a workspace behind, which the caller can
   delete.
3. **MCP `createWorkspace`** (`gatedCall` and `mintAsFirstMember` in the
   `mcp-caller` module, lines 141-202). `index.resolveWorkspace(handle)` is
   keeper-wide. If it finds another person's workspace, the call is refused
   `not_a_member`. If it finds nothing, a workspace is minted and the tool
   runs. Same question, same answer.

Server mode already turns down the cheaper version of this leak. The
`nameKnownWorkspaces` option of `bootSelfHostDeps` lists existing workspaces
in an unknown-workspace refusal only for the stdio entry and the local
daemon, "because its refusal is uniform on purpose". These three paths are
where that uniformity breaks down. A segment comes from a display name
("acquisition-target-q3", "layoffs-2027"), so an oracle over segments is
an oracle over what people call their private work.

### A latent second instance: tenants

Each store reads `workspaces` through the tenant-bound handle, so
`listWorkspaces()` only returns the caller's tenant. The unique index,
however, covers every tenant. Once a keeper holds two tenants (ADR-0045),
creating `design` in tenant B while tenant A holds it gets past
`firstFreeSegment` (B's list has no `design`). It then fails at the index,
and the POST's `catch` answers 409, which is a cross-tenant oracle. This
is read from the code (`isSegmentUniqueViolation` keys on the index, not on
the tenant), not reproduced, since no keeper can hold a second tenant yet. Today
every keeper has exactly one tenant, `self-host`, so this cannot happen
yet. Each option below fixes it as a side effect, because each one
replaces the index.

### Who this concerns

| keeper | people | oracle today |
|---|---|---|
| browser (IndexedDB registry) | one | none: nobody else to hide from |
| local daemon | one, the machine owner (ADR-0050 decision 3, ADR-0049's local half retired) | none, for the same reason. It never mounts the membership gate |
| edge keeper (ADR-0052, not built) | one: a personal workspace per Durable Object | none |
| server mode (ADR-0046/0049) | many, members-only | the three paths above |

## Options

All three options keep the canonical-id address (`/w/<ULID>`) as the form
that survives a rename, and all three replace `workspaces_segment_unique`.
They differ in what a segment is unique WITHIN.

### Option A — per-owner namespace

A server-mode workspace belongs to one **namespace**: the tenant user who
created it, recorded once at creation. This is not ADR-0049's `owner`
role. A workspace can have several owners, and owners come and go, while
an address needs exactly one stable holder. A segment is unique per
`(tenantId, namespace, segment)`.

- **URL shape.** On server mode, `/w/<owner>/<segment>` and
  `/w/<owner>/<segment>/d/<path>`. A one-component `/w/<x>` then means only
  the canonical id. If owner keys can never be ULID-shaped (the refinement
  `workspaceSegmentSchema` applies today, moved to the owner key),
  `/w/<ULID>/d/…` and `/w/<owner>/<segment>/d/…` parse unambiguously by
  whether the first component is ULID-shaped. No reserved segment is
  needed.
- **The owner component.** This has to be decided, because a chosen
  per-tenant user handle reproduces the oracle one level up: picking
  `alice` would reveal whether someone else already holds `alice`. Today a
  tenant's user directory is administrator-only (`GET /api/people`), and an
  owner adds a member by user id, so user handles are not public either.
  The candidates are an opaque per-user key that is minted, never chosen,
  and never collides (no oracle, but unreadable), or a chosen handle with
  the user-level oracle accepted. This is open question 1.
- **Migration (0.0.x, no compatibility kept).** Add a namespace column.
  Backfill it from each workspace's earliest `owner` membership. A
  workspace with no membership row at all needs an operator to assign one;
  the migration refuses rather than inventing one. What breaks: every
  server-mode `/w/<segment>` bookmark and copied URL (the `/w/<ULID>` form
  keeps working), the operator command line's `--workspace=<segment>`
  (it becomes `<owner>/<segment>` or the id), and any MCP client that
  stored another person's bare segment.
- **A shared link** is `/w/<owner>/<segment>/d/<path>`, readable and the
  same for every member. Only the holder's rename changes it.
- **MCP handle.** A bare segment resolves inside the CALLER's namespace,
  which is the common case, and is exactly today's handle for anyone using
  their own workspaces. A workspace in someone else's namespace is reached
  by the canonical id, or by a qualified handle, which needs
  `workspaceIdSchema` to admit one separator. That second route changes a
  published tool surface: it is the `mcp-tool-surface` skill's procedure
  and ADR-0031's scoreboards, and it is its own increment. `createWorkspace:
  true` only ever mints in the caller's own namespace.
- **The single-person keepers do not change.** The browser, the local
  daemon and the edge keeper each have one namespace, so it is implicit and
  `/w/<segment>` stays as it is. That gives server mode a different grammar
  from the others. ADR-0019's addendum argued against a grammar per keeper,
  because ADR-0004 chooses the keeper at page load and one path has to mean
  "this workspace, whichever keeper this session runs". That argument was
  about the browser and the daemon sharing one origin. A server-mode keeper
  serves its own web app from its own origin (ADR-0047), so a server-mode
  URL is never opened against a browser or local-daemon session. This is
  open question 2.
- **How the oracle closes.** Create, rename and mint each check only the
  caller's namespace, and the caller already sees all of it, so a `409` or
  a `-2` tells them nothing new. That holds for the namespace holder. A
  co-owner who renames a segment inside the holder's namespace would still
  learn which segments the holder uses there. So either segment changes are
  limited to the holder (co-owners can still change `displayName`), or that
  narrower leak is accepted. This is open question 3.
- **A cost of its own.** ADR-0051 lets a deleted person's workspaces live
  on with their other owners, so the namespace's holder can be deleted.
  Their workspaces then need a new holder, and every URL that carries the
  old namespace dies. That is ADR-0019's accepted "a renamed segment's old
  URL is dead", but triggered by deleting a person rather than by a rename.

### Option B — per-member view

A segment becomes a property of a **membership**, not of the workspace.
Each member has their own name for each workspace they belong to. It is
unique among that member's workspaces, and resolution only looks at the
caller's memberships.

- **URL shape.** `/w/<segment>` stays exactly as it is, and the grammar
  stays the same for every keeper.
- **Why it has to be per membership.** Suppose segment stayed a column on
  the workspace and was only checked for collisions within the caller's
  view. Then two members' views overlap, and adding Bob to Alice's
  `design` either fails because Bob already has a `design` (which tells
  Alice something about Bob's workspaces, the same oracle), or gives Bob a
  different name for it. Only the second is safe, and that second answer is
  the per-membership segment.
- **Migration.** Copy `workspaces.segment` into each of that workspace's
  membership rows. Today's segments are keeper-wide unique, so no collision
  appears at migration time, and every existing link keeps working for
  every member it worked for. What changes is afterwards: names drift
  apart. An operator, or an operator-issued grant (`daemon-token`,
  `macaroon`), has no view of its own, so the command line and those grants
  address workspaces by id only.
- **A shared link** CANNOT carry the segment. Alice's `/w/design` is Bob's
  `/w/design-2`, or a different workspace altogether, or nothing. A link
  meant for someone else has to carry the canonical id, so the readable URL
  is only good for one's own bookmarks. That is the opposite of what
  ADR-0019 put the segment in the URL for.
- **MCP handle.** Resolves within the caller's memberships.
  `createWorkspace: true` mints when the caller's view has no such segment,
  and never collides with anyone else's. Operator-issued grants have to use
  ids.
- **The single-person keepers** do not change. One person's view is the
  whole registry.
- **How the oracle closes.** There is nothing global to collide with.
  Every collision is within the caller's own memberships.

### Option C — opaque suffix (for comparison; not the owner's pick)

A server-mode segment always carries an opaque suffix the keeper mints:
`design-k7q2m`. The person chooses only the base.

- **The suffix must be unconditional.** Adding one only on collision is
  `firstFreeSegment` again, where the suffix being there is the answer.
  Always suffixing, with enough entropy that the keeper retries a clash
  silently, means a base's availability never shows up in any response.
- **URL shape.** `/w/<base>-<suffix>`, the same grammar as today. This
  resembles the products that put a readable title beside an opaque key in
  the URL. Unlike those, the suffixed segment still IS the identifier, not
  a cosmetic tail.
- **Migration.** Every existing server-mode segment gets a suffix. Every
  segment link breaks; `/w/<ULID>` links keep working.
- **A shared link** is readable-ish and the same for every member.
- **MCP handle.** `createWorkspace: true` with `design` mints
  `design-k7q2m` and returns it. A caller that comes back with the bare
  `design` matches nothing and gets the uniform refusal. A model therefore
  has to keep the handle it was given, not the one it asked for, which is
  a tool-surface change (`mcp-tool-surface`).
- **The single-person keepers** keep bare segments. They have nothing to
  hide, and a suffix costs readability there for nothing.
- **How the oracle closes.** The chosen part never collides, because it is
  never the whole key.

### Side by side

| | A — per owner | B — per member | C — opaque suffix |
|---|---|---|---|
| server-mode URL | `/w/<owner>/<segment>` | `/w/<segment>` (the caller's own) | `/w/<base>-<suffix>` |
| a link works for another member | yes | only in its id form | yes |
| existing server-mode links | segment form breaks; id form survives | survive | segment form breaks; id form survives |
| MCP bare segment | the caller's namespace | the caller's view | must be the minted handle |
| MCP tool-surface change | only for qualified handles | none | yes (keep the returned handle) |
| single-person keepers | unchanged | unchanged | unchanged |
| residual leak | a co-owner renaming inside the holder's namespace (Q3); the owner handle itself if chosen (Q1) | none | none |
| new identity to manage | a namespace holder, and a person's deletion moves it | a segment per membership | none |

## Recommendation

**Option A, with the owner component minted rather than chosen, segment
changes limited to the namespace holder, and the single-person keepers left
on `/w/<segment>`.**

- It is the shape the owner asked for, and the only one that keeps a
  readable URL that means the same thing to every member. B gives that up
  by construction. C keeps it only by making the readable part less
  readable.
- Its bare-segment MCP handle is today's handle for anyone working in
  their own workspaces. The qualified form can wait for its own
  tool-surface increment, because the canonical id already reaches
  everything else.
- It closes the tenant gap as part of the same index change.
- The two places a leak could remain, the owner handle and a co-owner's
  rename, are closed by the two choices above, and both are cheap to
  reverse later if the owner decides a readable user handle is worth its
  oracle.

Implementation is deliberately not planned here. Once the questions below
are answered, the slices follow `architecture-map.md`'s direction: the
schema and index in `model`/`ports`, then the daemon's registry and its
three oracle paths, each with a test that reproduces today's 409 / `-2` /
`not_a_member` difference first, then the web app's grammar.

## Open questions for the owner

1. **The owner component in a URL**: a minted opaque key (no oracle,
   unreadable) or a chosen user handle (readable, and reveals whether a
   handle is taken within a tenant)?
2. **Two grammars**: may server mode use `/w/<owner>/<segment>` while the
   single-person keepers keep `/w/<segment>`, or should every keeper carry
   an owner component (a fixed one where there is one person) to keep a
   single grammar?
3. **Who may change a segment**: only the namespace holder, or every
   ADR-0049 owner, accepting that a co-owner can probe the holder's
   namespace?
4. **When the namespace holder is deleted** (ADR-0051): which remaining
   owner inherits the namespace, given that every URL carrying the old one
   dies?

## Consequences

- If accepted, ADR-0019's "unique per keeper" becomes "unique per keeper
  for a single-person keeper, and per namespace on server mode", and
  `workspaceSegmentSchema`'s comment and `docs/explanation/domain-model.md`
  change with the implementation.
- Server-mode segment URLs break once. The id form keeps working. At 0.0.x
  that is the vocabulary rule's accepted cost.
- Nothing changes for the browser keeper, the local daemon or the edge
  keeper under any of the three options.

## Alternatives considered

The three options above are the alternatives. Two more were dismissed
without being designed in full:

- **Keep global uniqueness and make the refusals uniform.** For example,
  answer a taken rename the same way as a malformed one. That does not
  work, because the person still needs to know that the name they typed
  was not applied, and any answer that differs from success is the oracle.
- **Rate-limit the three paths.** That slows the oracle down; it does not
  close it. The probe is one request per name, and the names worth probing
  are few.
