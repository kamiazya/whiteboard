# ADR-0053: A workspace segment is unique within its owner's namespace, not across the keeper

**Status:** Accepted, 2026-10-17. The owner chose the direction that day
("namespace segments per owner", design first), then answered the four open
questions this record raised. The answers are the Decision section below.
The implementation is sliced at the end of this record; slices 1, 2 and 4
(model/ports, the daemon registry with its three oracle paths, and the MCP
tool surface) are built, slice 3 is not.

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

These options are recorded as they were proposed. Where one says "this is
open question N", or makes a claim that one of the answers changed (such
as Option A leaving the single-person keepers on `/w/<segment>`), the
Decision section supersedes it.

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

## Decision

**Option A: a segment is unique within its owner's namespace, on every
keeper, under one URL grammar.** The proposed record recommended Option A,
and the owner chose it. The four answers below settle the points Option A
left open.

### 1. The owner component is split by use: an opaque form for links that leave the workspace, a readable handle inside the app

There are two address forms, and which one is used depends on who the
address may reach.

- **Inside the authenticated app**, URLs read
  `/w/<handle>/<segment>/d/<path>`. The `<handle>` is a per-tenant user
  handle that its user chooses, unique per `(tenantId, handle)`. It is
  never ULID-shaped (the refinement `workspaceSegmentSchema` applies today
  moves to the handle), so the first component tells the two forms apart.
  A user who has not chosen one gets a handle derived from their display
  name through `deriveWorkspaceSegment` and `firstFreeSegment`. The
  workspace segment keeps its own grammar and becomes unique per
  `(tenantId, namespace, segment)`.
- **A link that may reach someone outside the workspace** uses the opaque
  form, without exception. That covers an invitation, a "copy link" meant
  for someone who is not yet a member, and any future share surface. The
  opaque form names the **workspace**, not the owner's namespace. A link
  points at one thing, and a namespace-level link would hand the
  recipient an address that covers workspaces they were never sent.
  - The opaque form is `/w/<workspaceId>`, the canonical ULID that already
    resolves in that position (ADR-0019). It is minted, stays the same
    across a rename of the handle or the segment, and carries nothing
    anyone chose.
  - No separate link key is minted. Access is decided by membership, not
    by holding the link, so a second key would be a fourth identity layer
    that grants nothing the id does not.
  - The cost of using the id: a ULID encodes its creation time to the
    millisecond, so anyone holding the link learns when the workspace was
    created. That is accepted. If it stops being acceptable, the upgrade
    is a separately minted random key that resolves to the workspace id.
  - An invitation link keeps carrying its invitation token
    (`invitePageUrl`), which is a capability to be admitted, not an
    address. Once the invitation is accepted, it lands on the opaque
    workspace form like any other link.
- **The opaque form becomes the in-app URL after sign-in.**
  1. An unauthenticated request for any `/w/…` path is answered the same
     way whatever the path names: it is sent to sign-in, and nothing about
     the path is resolved before a session exists.
  2. After sign-in, the app resolves `/w/<workspaceId>` through the
     membership gate.
  3. A member is moved, by replacing the history entry, to
     `/w/<handle>/<segment>/…` built from the CURRENT handle and segment.
  4. A non-member gets the same `not_a_member` refusal the gate gives
     today. This is the same rule as `workspaceHandle`'s "emit the segment
     when there is one", applied after access is known rather than before.
- **A copied in-app URL opened by a non-member** gets the same answer as
  every address they cannot reach. The gate answers `not_a_member` for all
  of these alike:
  - `/w/alice/secret`, where the workspace exists but they are not a
    member;
  - `/w/alice/nothing`, where Alice has no such workspace;
  - `/w/nobody/x`, where no user holds that handle.

  This keeps the property `workspaceAccess` has now: resolution may know
  the answer, but the response does not depend on it.

**The consequence, accepted.** Whether a handle exists is visible to the
tenant's AUTHENTICATED users. Choosing a handle that is taken is refused,
and a user's handle is visible in every in-app URL they share with a
member. The owner accepted this, since anyone who can ask is signed in to
the tenant. It must not be visible to an UNAUTHENTICATED caller: no path an
unauthenticated request can reach may answer differently for a handle that
exists. Step 1 above is how, and the implementation pins it with a test.
What stays hidden even from signed-in users is the thing the oracle was
about: which WORKSPACES exist in another person's namespace.

### 2. One grammar on every keeper; single-person keepers carry the fixed component `me`

The browser, the local daemon and the edge keeper also address a workspace
as `/w/<handle>/<segment>/d/<path>`. Their one namespace is spelled with
the fixed handle **`me`**.

- `me` is valid under the handle grammar and is not ULID-shaped.
- It reads correctly where there is exactly one person.
- Server mode reserves it, so no tenant user can choose `me` and
  `/w/me/…` never names somebody else's namespace there. A server-mode
  `/w/me/…` matches no user, so it gets the uniform `not_a_member`.
  `me` is deliberately NOT an alias for the caller's own handle: a link
  that meant something different to each person who opened it would be the
  shared-link hazard Option B was rejected for.
- The opaque form `/w/<workspaceId>` resolves on every keeper as it does
  today.
- `local` was not used for this, because the vocabulary rule retires it
  for anything about where a workspace is kept.

**Existing `/w/<segment>` links: break them, do not redirect.** This is
the recommendation, to be confirmed in the web-grammar slice.

- After the change, a one-component `/w/<x>` resolves ONLY as a canonical
  id. A non-ULID one-component path gets the same unknown-address answer as
  any address that names nothing.
- A redirect would be safe on a single-person keeper, which has one
  namespace to redirect into. On server mode it cannot be safe: choosing
  the namespace would mean resolving a bare segment keeper-wide, which is
  the oracle this record closes.
- A redirect on one keeper and not the other would bring back the
  per-keeper grammar answer 2 rules out.
- At 0.0.x, the vocabulary rule's no-compatibility policy makes the break
  the cheaper honest answer.
- What breaks: bookmarks, copied URLs, and any route string the web app
  stored that carries `/w/<segment>`. Id-form links survive on every
  keeper.

### 3. Every ADR-0049 owner may change a segment

Any owner of a workspace may rename its segment, not only the namespace
holder. A rename checks collisions within the workspace's namespace.

**The consequence, accepted.** A co-owner of one of Alice's workspaces can
probe Alice's namespace: a rename to a segment Alice already uses answers
`409`. What a co-owner learns is limited to which segments are taken in
that one namespace. They learn nothing about those workspaces' contents,
display names or members, and nothing about any other namespace.

Creating a workspace always mints it in the creator's own namespace, and
so does MCP `createWorkspace: true`. A workspace changes namespace only
through answer 4.

### 4. When the namespace holder is deleted, the oldest surviving owner inherits

When ADR-0051 deletes a person whose namespace holds workspaces, each of
those workspaces moves to its **oldest surviving owner**. That is the
current owner with the earliest membership `createdAt`, with ties broken by
user id. The membership row's `createdAt` is used because no
role-change time is stored. ADR-0051 already refuses to delete a
workspace's sole owner, so a surviving owner always exists.

- **URLs carrying the old handle stop working.** Id-form links survive.
  This is ADR-0019's accepted "a renamed segment's old URL is dead", now
  triggered by deleting a person.
- **A segment that collides in the inheritor's namespace** is suffixed
  with `firstFreeSegment` there. The inheritor sees all of their own
  namespace, so the suffix tells nobody anything new.
- **A deleted person's handle becomes free to choose again.** An old URL
  can then point into the new holder's namespace. It still reaches only
  workspaces the opener is a member of, so this can cause confusion but
  leaks nothing. No tombstone is kept, for the reason ADR-0019 keeps none
  for segments.

### MCP handles

A tool's `workspaceId` accepts three forms:

- the canonical id;
- the qualified `<handle>/<segment>`;
- a bare segment, as shorthand for the caller's own namespace (`me` on a
  single-person keeper, the caller's handle on server mode).

An MCP handle is an argument, not a link handed to somebody, so a
caller-relative shorthand is safe here in a way it would not be in a URL.
A qualified handle in another namespace is never minted, and gets the
uniform `not_a_member` whether or not the workspace exists. Admitting `/`
in `workspaceIdSchema`, and describing all three forms, changes a published
tool surface. Its exact shape is settled by that slice's `mcp-tool-surface`
procedure, not here.

### Implementation slices (1, 2 and 4 built)

The slices are listed in `architecture-map.md`'s dependency order. Each
starts from a failing test at its nearest layer.

1. **`model` / `ports`.**
   - Add a user-handle schema (the segment charset, never ULID-shaped, `me`
     reserved).
   - Make `resolveWorkspaceHandle` resolve the three address forms.
   - Make `WorkspaceSegmentTakenError` name the namespace it is unique in.
   - A property test covers parse and resolve of every form.
2. **The daemon registry and the three oracle paths.**
   - A migration replaces `workspaces_segment_unique` with
     `(tenantId, namespace, segment)`.
   - It adds the namespace column, backfilled from each workspace's
     earliest `owner` membership. A workspace with no owner row is refused
     for an operator to assign, never guessed.
   - It adds the per-tenant user handle.
   - Red tests first, each reproducing today's difference, before the
     fix:
     - a rename to another person's segment answers `409`;
     - a create beside another person's segment answers `-2`;
     - MCP `createWorkspace` on another person's segment answers
       `not_a_member`.
   - The same slice adds the unauthenticated-uniformity test from answer
     1, and the cross-tenant case from "A latent second instance".
   - As built (migration `0046-workspace-namespace`): a workspace with NO
     membership at all is placed in `me` rather than refused. Every local
     daemon workspace is such a row, so refusing would stop every local
     daemon from migrating; on server mode a workspace nobody is a member of
     admits nobody, and `me` — which no server-mode user can hold — leaves it
     reachable by its id alone until an operator grants it a member. A
     workspace with members but no owner is refused, as above. Until slice 3
     the server-mode listing omits the segment of a workspace held in
     another namespace, since the web app would otherwise address it by a
     bare segment that means the caller's own namespace.
3. **The web app's grammar.**
   - `workspacePath`, `documentPath`, `parseWorkspaceRoute` and
     `workspaceHandle` move to `/w/<handle>/<segment>`.
   - The post-sign-in replacement of the opaque form.
   - A copy-link surface that emits only the opaque form.
   - The single-person keepers' `me`.
   - Browser-mode coverage of the route flow.
4. **The MCP tool surface**, through the `mcp-tool-surface` procedure.
   - The qualified handle and the three forms' descriptions.
   - ADR-0031's scoreboards re-pinned.
   - `pnpm smoke:e2e` extended to call a qualified handle.
   - The operator command line's `--workspace` changes in the same slice.
   - As built: every tool's `workspaceId` is one described schema, the
     pattern `^[\w-]+(\/[\w-]+)?$` with "Workspace id,
     `<handle>/<segment>`, or a segment of your own." (+767 model-visible
     bytes across the table, 10 fewer undescribed parameters).
     `server-core` no longer assumes `me`: `ServerDeps.callerNamespace`
     answers whose namespace a bare segment means, and the tool wrapper,
     `/api/v1`'s resolution and the `createWorkspace` mint all ask it. The
     daemon answers from the same records its gates resolved with — the
     `/api` middleware's for an `/api/v1` request, the `/mcp` caller's for
     a tool call — so `/api/v1` can no longer serve a different workspace
     from the one the membership gate admitted. An operator-issued grant
     names no user and so has no namespace: it reaches a workspace by id or
     qualified handle only, and server-core mints nothing for it. A
     qualified handle in another namespace is never minted; on server mode
     it is refused `not_a_member` whether or not the workspace exists. The
     operator commands' `--workspace` takes `<id|handle/segment|segment>`,
     where a bare segment reaches only the `me` namespace.

## Consequences

- **ADR-0019 is amended.** "Unique per keeper" becomes "unique per
  namespace". When implemented, `workspaceSegmentSchema`'s comment and
  `docs/explanation/domain-model.md` change in the same increment.
- **Every keeper's `/w/<segment>` links break once, and id links survive.**
  At 0.0.x that is the vocabulary rule's accepted cost.
- **A person gains a fourth identity-bearing name, their handle.** Its
  existence is visible to signed-in users of the tenant (answer 1). It is
  invisible to an unauthenticated caller, and that has to be held by a
  test, not by care.
- **Within one namespace a co-owner can probe it** (answer 3). Across
  namespaces, nobody can. Across tenants, the replaced index closes the
  latent instance.
- **Deleting a person can now break URLs** (answer 4) as well as
  removing access.

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
