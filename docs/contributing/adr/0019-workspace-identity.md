# ADR-0019: Workspace identity is three layers, in both keepers

**Status:** Proposed

## Context

A workspace is currently identified by a single string that plays three roles
at once: the canonical key that versions, branches, snapshots and `DocRef`
values are stored under; the user-facing handle that appears in URLs
(`/api/w/:workspaceId`, the `#wb=` pairing fragment); and the display name a
human reads. Nothing separates them:

- The browser keeper hard-codes `BROWSER_WORKSPACE_ID = 'local'`, so every
  browser workspace in existence carries the same identity. Whole-workspace
  promotion sidesteps the collision only because it never carries the
  workspace id across the keeper boundary (the daemon pins `'local'` as
  unmintable and answers 404), and that stopgap cannot survive the browser
  holding more than one workspace.
- Daemon workspace ids come from two allocators, and neither separates the
  layers. A fresh install's current workspace is minted by `nanoid()`
  (`current-workspace.ts`) — machine-random, so unreadable as a handle, yet
  still unrenameable because it is the storage key. Additional workspaces
  take caller-chosen strings (`default`, `dev-check`), which read well but
  collide across daemons: two daemons both holding `default` are two
  different workspaces under one name, which any future cross-daemon or
  sync feature would trip over. The single string forces that choice —
  readable-but-colliding or unique-but-opaque — because it carries all
  three roles at once.
- `workspaceSummarySchema` carries `{ workspaceId }` and nothing else, so
  the promote dialog's workspace selector shows raw ids — exactly what
  `apps/web/DESIGN.md`'s "Raw identifiers are not chrome" rule exists to
  prevent, and there is no other field to show.

The document layer solved this same problem in ADR-0007/0008/0009: a
machine-minted ULID `documentId` is the durable identity that references and
sync are keyed on; the `(workspaceId, path)` pair is the user-facing address;
the display name is free text with no identity duties. Workspaces are the one
entity still missing that split.

One word is unavailable. `alias` already means document-reference resolution
(the `[[target|alias]]` display-text half and codec's `AliasResolver`
contract), and vocabulary.md's Workspace row assigns it to document
placement. A workspace handle called `alias` would give one entity two
unrelated senses of the same word.

## Decision

Workspace identity becomes the same three layers a document has, in **both**
keepers:

| layer | field | rules |
|---|---|---|
| canonical | `workspaceId` | machine-minted bare ULID. The only key references, versions/branches, storage rows, and sync ever use. Never shown as chrome, never typed by a human. |
| user-facing | `segment` | unique per keeper, renameable, URL-safe. Owned by the keeper's registry (daemon `workspaces` table row / browser IndexedDB registry row), **not** CRDT-synced state. |
| naming | `displayName` | free text, no uniqueness, no identity duties. Also registry-owned. |

Decisions taken with the words they were taken in (user decisions,
2026-08-28):

- **Canonical ids are bare ULIDs, not prefixed.** `ws_<ulid>` was considered
  as defense-in-depth against workspace/document id confusion and rejected:
  `documentId` is already a bare ULID, so a prefixed workspace id buys an
  asymmetry, and the confusion it guards against is guarded where this
  codebase guards everything else — Zod schemas at every boundary, and
  tests. `workspaceIdSchema` (canonical) and the segment schema are distinct
  types from day one.
- **URLs resolve segment-first with canonical-id fallback.** The visible URL
  uses the human-readable segment; a URL carrying the canonical id always
  resolves as the durable form. To keep the two resolvable in one position, a
  segment must not itself look like a ULID: segment validation rejects a
  26-character Crockford-base32 string with a leading `[0-7]` (the ULID
  shape). Resolution tries the segment registry first, then the id.
- **A renamed segment's old URL is dead, and that is accepted.** No
  tombstone or redirect table. ADR-0008 already made this call at the
  document layer and the reasoning transfers — with the difference that here
  the canonical-id URL exists as the durable link, so anything that needs
  rename-survival uses the id form. Revisit only with evidence of real
  breakage.
- **v1 management surface is create + switch + rename.** Rename covers both
  displayName and segment (segment rename swaps the URL in place). Delete is
  deliberately **not** in v1: a never-promoted browser workspace has no
  backup story, and a confirm dialog is not a sufficient guard for that
  data-loss shape. Delete waits for an export or promote-first story.
- **Switching browser workspaces is an in-SPA route change, no reload.**
  ADR-0004's "the backend mode is decided once at page load" governs
  **keeper** swaps (browser-kept vs daemon-kept pages), not movement between
  two workspaces of the same keeper. This ADR records that interpretation
  explicitly. The switch must settle the outgoing workspace's in-flight
  writes before the incoming one mounts (flush-before-switch); the switch
  slice pins that invariant with a test.
- **Promotion neither preserves nor mints a workspace identity.** The
  whole-workspace move keeps its shape: it merges the browser record's
  CONTENT into an existing daemon workspace the user chooses, and the
  target's canonical id, segment, and display name are the target's own,
  untouched by the move. The source browser workspace's identity metadata
  never crosses the keeper boundary, so a move can violate no registry
  uniqueness and split no `DocRef` — document identity carries (that is the
  point of promotion), workspace identity does not, and document-path
  collisions inside the merged record keep surfacing as shadowed (ADR-0007
  addendum). A future "promote as a NEW daemon workspace" would mint a fresh
  daemon-side canonical id at creation like any other workspace, and is out
  of scope here.
- **Names and segments are per-keeper registry metadata, not CRDT state.**
  The daemon already keeps `workspaces.displayName` in the registry row —
  `names-store.ts` states the rationale in place ("it names the container,
  not any document, and the registry row is its home") — and the browser
  mirrors that with an IndexedDB registry row. Promotion merges a
  workspace's *content* record and carries no identity metadata at all; the
  bullet above says why.
- **Auth scope is untouched, as a named non-goal.** Daemon grants remain
  resource-type-scoped; no slice of this initiative narrows or widens a
  grant to specific workspace ids. Workspace-scoped auth is a separate
  future decision, recorded here so its absence reads as chosen rather than
  forgotten.

`'local'` used as a workspace identity is retired by this decision — the
last holdout of the vocabulary rule that `local` never names where a
workspace is kept. The word itself stays correct in its network sense
(vocabulary.md's keeper-axis section governs).

## Consequences

- The stored shapes keyed on the old ids (daemon `workspaces`, `versions`,
  `branches`, docKey-embedded snapshot/delta rows; browser IndexedDB keys;
  `DocRef.workspaceId`; the user-settings `lastConnectedWorkspaceId`) are
  re-keyed by migration, keeper by keeper. Because kysely's Migrator does
  not wrap a migration in a transaction, the daemon's multi-table re-key
  must be idempotently re-runnable and tested against interruption
  mid-table, not only round-tripped happy-path.
- `DocRef.workspaceId` tightens to the canonical-ULID schema only **after**
  both keepers' minting migrations have landed — tightening first would
  reject live data (`default`, `'local'`) the moment it merged.
- `workspaceSummarySchema` widens to carry `segment` and `displayName`, and
  the widening flows through the published
  `@kamiazya/whiteboard-mcp/api-contracts` subpath that
  `daemon-api-client.ts` consumes — the promote selector can then show names
  instead of raw ids, which is the first user-visible payoff and lands
  before any breaking change.
- The browser keeper stops being definitionally single-workspace, which
  falsifies `BROWSER_CAPABILITIES.workspaces: false` and the marketing copy
  built on it; the capability flips only in the slice that ships the
  switcher, together with rewritten daemon-differentiator copy.
- User docs (`domain-model.md`'s "a browser keeper has exactly one",
  `connect-to-local-daemon.md`) are **not** updated by this ADR: docs
  describe shipped behavior, and each statement changes in the slice that
  ships the behavior it describes.

## Addendum (2026-08-29): the address grammar, and what shipped

Everything above decided what a workspace's identity IS. Implementing it
forced three questions the Decision did not answer, and left one place where
the code does not yet do what the Decision says.

### One URL grammar, for both keepers, at `/w/:workspace/d/:path`

The two keepers had two grammars — the browser's `/canvas/:path` and the
daemon's `/w/:workspaceId/document/:path` — which was not a decision anyone
took. It was two features growing separately, and it cost something real:
the "Work in this browser instead" escape leaves a daemon address behind, and
under two grammars that address parsed as nothing here, so the app silently
showed the index for a URL it could not read.

Both keepers now use `/w/:workspace/d/:path`, resolved segment-first with the
canonical-id fallback the Decision already fixed.

- **The workspace is in the PATH, not the fragment or a query parameter.** A
  path segment is what identifies a resource; a query parameter is a
  parameter *over* a resource; a fragment (RFC 3986 §3.5) is a secondary
  resource *within* the primary one. A workspace is none of the latter two —
  it is the outermost part of what a document address identifies. That a
  browser-kept workspace is unreachable from another machine is a fact about
  the KEEPER, not about the address: in a single-page app the path is already
  interpreted entirely on the client, so "client-only" argues for the
  fragment no more than it argues against the path.
- **`d` rather than `document`, matching `w`.** The two positions in one
  address should read the same way.
- **The keeper is ambient, and stays out of the URL.** ADR-0004 decides
  browser-vs-daemon once at page load, so the address names a workspace *of
  whichever keeper this session runs*. Putting the keeper in the path would
  put a session-level fact in a document-level address.

The removal test settles what else belongs in a path: take a part out, and
ask whether what is left still identifies a resource. Take the workspace out
and the path names nothing; take a zoom level or an open panel out and it
still does. The first is address, the rest is view state.

### Branch and version addresses (decided, not implemented)

Worth fixing now because the answer is not the obvious one, and because a
later feature would otherwise invent a different shape.

Branches and versions are DOCUMENT-scoped in the schema — `branches` keys on
`(documentId, workspaceId, name)` and `versions` on
`(id, documentId, workspaceId, branchName)`, the `workspaceId` present
because a version's frontier points into that workspace's oplog. So the ref
sits AFTER the document, unlike git, where a branch scopes a whole tree:

```text
/w/:workspace/d/:path/@:ref
```

`@` is unambiguous in that position because a document path segment is ASCII
letters, digits and interior hyphens, so nothing a path can hold starts with
it. A ref resolves branch-name-first, then version id — the same
readable-first, durable-second shape the workspace position already uses.

**Not implemented, and the reason matters:** the browser keeper has no
versions and no branches (`BROWSER_CAPABILITIES` says so in three separate
flags), so this address has one keeper to serve and no user waiting for it.
It is recorded so the daemon's history UI adopts this shape rather than
minting another.

### What shipped, and the two rules building it produced

- **The browser workspace switch is in-SPA, as decided.** It shipped as a
  document load first, and what closed the gap was a second door rather than
  a redesign: the accessor still resolves ONCE — that is what makes the
  synchronous read at some twenty call sites possible — and
  `switchBrowserWorkspace` re-points it explicitly. React learns through a
  `useSyncExternalStore` subscription, so App and the index page follow a
  switch without either being rebuilt.

  Two rules came out of building it, and both are the kind that would be
  wrong if guessed:

  - **The switch resolve is STRICT where the boot resolve is lenient.** Boot
    falls back to first-listed because a stale bookmark should still open the
    app and there is no previous state worth keeping. A switch has one, so
    answering "go here" by going somewhere else — and then rewriting the
    address to match a place nobody asked for — is worse than declining. The
    address rewrite is what a declined switch falls back to, which is only
    distinguishable from a successful one because the resolve is strict.
  - **The address moves first and the runtime follows.** Same direction as
    everything else here: the switcher navigates, and an effect re-points the
    active workspace to whatever the address names. The rewrite guard added
    earlier in this initiative had to learn the difference — before this it
    read any unmatched address as a leftover and rewrote it, which would have
    fought every switch.

  **Flush-before-switch was already pinned**, and by the in-SPA path rather
  than the shipped one. Two `browser-backend.browser.test.tsx` cases hold it:
  a write still on the queue when `disconnect()` runs reaches storage, and a
  write in flight while the active workspace is RE-POINTED lands in the
  workspace it was made in rather than the one being switched to. The second
  simulates exactly what `switchBrowserWorkspace` now does in production.
  Both found real defects — `_doWrite` returned early on a nulled doc, and
  read the workspace id at execution time — so the invariant is guarded by
  tests that went red, not by a load that happened to make the hazard
  unreachable.
- **Rename landed in the increment after.** It needed the port, three
  implementations and the conformance suite, which is why it was not a
  corner of the switcher's own increment. The conformance suite asks more of
  it than of `createWorkspace`: an implementation may accept-and-ignore the
  identity layers on create, but a rename that ignored them would pass every
  case vacuously while doing the one thing it exists for to nothing.

  The FORM is where the three-layer model becomes visible to a person. Name
  and address are two fields, edited separately, because the segment is what
  every existing link already says — deriving it from the display name would
  break those links each time somebody fixed a typo in a name. Only what
  changed is sent, since the address write is the one that can be refused for
  a collision, and an unchanged field submitted back would put every name
  edit at that risk for nothing. Moving the address moves the URL with it; a
  name-only rename navigates nowhere, so the switcher re-reads its subject
  from what the rename ANSWERED rather than from a re-list.

  Renaming on the daemon still needs its route, and waits with creation
  below.
- **Writing a workspace is browser-only.** The daemon publishes
  `GET /api/workspaces` and nothing that writes one, so the switcher offers
  creation and renaming only where a keeper can honour them. Its own
  increment, and a published-contract change: the routes belong beside the
  daemon, in `@kamiazya/whiteboard-mcp/api-contracts`. The daemon's
  `DocumentIndex` already implements `renameWorkspace` — only the HTTP
  surface in front of it is missing.
- **`workspaces` stopped being a capability.** The Consequences above
  predicted the flag would flip to `true` for the browser. It did not flip —
  it was deleted. Once both keepers set it the same way it gated nothing, and
  the copy built on it promised a difference that is not there.
  `provider.capability-reach.test.ts` now fails on any capability both
  keepers agree on, so the next one cannot linger.

## Alternatives considered

- **Calling the user-facing handle `alias`.** Rejected: the word is taken by
  document-reference resolution (codec's `AliasResolver`, `[[target|alias]]`)
  and by vocabulary.md's Workspace row for document placement. Reusing the
  document layer's own three-layer vocabulary (id / segment-path / display
  name) costs no new word at all.
- **Prefixed canonical ids (`ws_…`).** Rejected as an asymmetry against the
  bare-ULID `documentId`; see Decision.
- **Canonical-id-only URLs.** The minimal-machinery option — no rename
  tracking, no disambiguation rule — but it makes every workspace URL
  opaque, and the document layer already accepted renameable, readable
  addresses as worth their cost. Rejected in favor of segment-first with id
  fallback.
- **Segment-only URLs.** Human-readable, but a rename then either kills
  every old link or demands the redirect machinery ADR-0008 declined to
  build. The id fallback provides the durable link for free.
- **CRDT-synced displayName/segment.** Would make renames replicate across
  a user's devices, but puts identity metadata inside the mergeable content
  record, where a merge could produce two workspaces contesting one segment
  the way paths contest today — a conflict class the registry design makes
  unrepresentable per keeper. Revisit only if a real cross-device rename
  driver appears.
