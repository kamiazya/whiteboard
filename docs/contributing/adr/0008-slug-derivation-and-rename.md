# ADR-0008: Slug derivation, rename, and sibling uniqueness

**Status:** Proposed

## Context

[ADR-0007](0007-canvas-identity-and-store-split.md) fixed `(workspaceId,
slug)` as the canonical user-facing canvas identity and deliberately left
three things open. This ADR closes them, and it does so with measurements
rather than expectations — each one turned out differently than the prose
around it suggested.

### 1. Derivation loses non-Latin names entirely

`deriveDisplaySlug` lowercases, replaces every run of non-`[a-z0-9]` with
`-`, trims, and falls back to `untitled`. Run against realistic Japanese
names (this is the real function, not a paraphrase):

| name | derived slug |
|---|---|
| リリース計画 2026 | `2026` |
| 構成図 | `untitled` |
| 議事録 8月 | `8` |
| Design Notes | `design-notes` |
| 設計メモ | `untitled-2` |
| アーキテクチャ図 | `untitled-3` |

Two distinct failures. Names with no ASCII collapse to `untitled`,
`untitled-2`, `untitled-3` — mutually indistinguishable, which is precisely
what a secondary line under a display name exists to prevent. Names that
merely *contain* digits keep only the digits: `リリース計画 2026` becomes
`2026`. That second case is not Japanese-specific; any script plus a year or
a month lands there.

ADR-0007 point 3 gives the derived slug a forward-looking purpose: it matches
the daemon charset "so a later promotion to real slugs needs no
re-derivation." Under promotion these strings stop being cosmetic and become
the canonical identity that URLs, sync, branches and bookmarks key on. The
promotion path is booby-trapped for anyone not naming canvases in ASCII.

Nothing is broken yet: `deriveDisplaySlug` has no caller. The line is cheap
to draw now and expensive later.

### 2. Rename is already implemented, just unwired

ADR-0007 defers rename because "it changes what sync, branches, versions, and
bookmarks key on." For everything *inside* the daemon, that is already false.
`branches-store.ts` carries a `── slug rename ──` section whose
`_renameCanvasSlug` updates one column, and whose comment states the reason it
can:

> Update only `canvases.slug`. Branches and versions FK on `canvasId` so they
> do not need to move; the blob path also uses `canvasId` so the `.loro` stays
> put.

The internals are already keyed on the row id. `_renameCanvasSlug` has **no
caller anywhere** — no route, no tool. Rename is unwired, not unsolved.

The OpenCanvas world is in the same position from the other direction. Links
are stored as `wikiLink { canvasId }`, resolved from `[[alias]]` on the way in
and re-derived to a path on the way out through the injected
`CanvasPathResolver`. A rename cannot break a stored link there either.

What genuinely breaks on rename is what left the system: URLs someone
bookmarked or pasted into a chat. That is a real cost, but it is a different
and much smaller claim than the one the deferral rests on.

`deriveAliasHistoryRows()` — the machinery that would redirect an old alias —
returns `[]`. It is a stub with a caller, so the redirect story is designed
but not implemented.

### 3. Sibling uniqueness is not enforced after a merge

ADR-0007 point 1 notes that "the daemon's storage already enforces
[slug] uniqueness per workspace." True for the workspace/slug store, whose
`canvases_ws_slug_unq` is a SQL constraint. Not true for the OpenCanvas
store: `WorkspaceTree.#assertNoSiblingConflict` runs inside `createNode` and
`move`, which are *local mutations*. Two peers can each create `notes` under
the same parent, merge, and land a tree that violates the invariant with
nothing to detect it — CRDT merge does not re-run a constructor's guard.

This matters more, not less, under ADR-0007's convergence direction: if the
two worlds meet on slug identity, the world with the weaker guarantee sets
the ceiling.

Google Drive is the same shape and answers it by not having the invariant:
duplicate names in one folder are legal, because identity is an opaque file
id rather than a path. The `(1)` suffix people associate with Drive is added
by **Drive for Desktop**, at the point where files are projected onto a local
filesystem that *does* require unique siblings — the stored data is never
touched. Two structural facts put us in the same position: the alias index's
primary key is `(workspaceId, seq)`, not `(workspaceId, alias)`, so duplicates
break no constraint; and this package's own rule is that "alias is always
derived, never stored" — `resolveAlias` builds the path by walking parents at
read time. We already have Drive's projection layer.

## Decision

1. **A slug is never derived from a name. It is derived from creation
   order.** New canvases get `untitled`, `untitled-2`, … exactly as ADR-0006's
   no-name-at-creation flow already produces, in every mode. The display name
   carries meaning; the slug carries addressability. This is what the daemon
   already does — the decision is to stop `deriveDisplaySlug` from becoming
   the exception, and to delete it rather than wire it up.

   ADR-0007's rationale for slug-canonical identity says slugs are "what users
   see, share, and reason about." For an auto-derived `untitled-7` that is not
   true, and the ADR's own point 2 is what makes it untrue. The property that
   actually distinguishes a slug from a ULID here is that it is **short and
   typeable in a URL**, which is a good reason and survives this decision
   intact. This ADR does not reopen point 1; it corrects the reason attached
   to it.

2. **The secondary line under a display name shows the slug, and browser-local
   shows nothing there until it has real slugs.** A derived label that reads
   `untitled` for six different canvases is worse than no label. Browser-local
   canvases are addressed by UUID and have no slug to show; the list should
   show the display name alone rather than a placeholder that cannot
   distinguish rows.

3. **Rename is allowed, and is wired to the existing implementation.**
   `_renameCanvasSlug` gets a route and a caller. Renaming changes one column;
   branches, versions, blobs and stored links are unaffected because they key
   on ids. The cost is external links, which is handled by point 4 rather than
   by forbidding rename.

4. **An old slug keeps resolving.** `deriveAliasHistoryRows` stops being a
   stub: a rename records the retired slug, and a lookup that misses the live
   slug falls back to alias history and responds with a redirect to the
   current one. This is the piece that makes point 3 safe for URLs that have
   already left the building.

5. **Duplicate sibling segments are legal, and the derived ALIAS
   disambiguates them.** The tree stores whatever the merge produced; nothing
   rewrites a document on read. `resolveAlias` appends a deterministic
   discriminator (`canvasId` order, the later one gaining `-2`) when a node's
   segment collides with a sibling's, exactly as Drive for Desktop suffixes
   only its filesystem projection. The derivation is a pure function of the
   tree, so it is idempotent and identical on every peer by construction
   rather than by convergence.

   `#assertNoSiblingConflict` stays on `createNode`/`move`, demoted from
   invariant to courtesy: when we can see the collision coming we still refuse
   it, because two canvases called `notes` are rarely what someone meant. When
   we cannot see it — a concurrent create on another device — we cope instead
   of corrupting. Drive draws the line in the same place.

## Consequences

- `deriveDisplaySlug` and its tests are deleted. It has no caller today, so
  this is a deletion rather than a migration — the cheapest moment there will
  ever be.
- Point 2 makes the browser-local list simpler, not richer: one line instead
  of two. The information it would have shown does not exist yet.
- Rename becomes a user-visible feature, which the header work has been
  routing around: `WorkspaceTopBar` still owns rename precisely because
  `DaemonCanvasPage` has no canvas row, and moving copy-URL and export down
  waits on canvas-name resolution being lifted out of that component.
- Alias history stops being write-only, which also gives the
  `workspaceIndex*` tables their first production consumer — ADR-0007 notes
  they are write-only today and must not be described as a lookup path until
  something reads them. This is that something.
- Point 5 adds no write path at all, which is the point: an earlier draft
  reconciled duplicates by mutating the tree on load, and a document rewritten
  on read is a class this codebase has rightly avoided. Deriving instead keeps
  the change inside a pure function. What it does need is a property test that
  the same tree always yields the same aliases regardless of node visit order,
  and that a duplicate never shadows its sibling.
- An alias is no longer guaranteed stable across a concurrent create: the
  node that loses the tie-break gains a `-2` in paths derived after the merge.
  Stored links are unaffected — they hold `canvasId` — so this costs only the
  human-typed `[[alias]]` form, which was already a convenience over the
  canonical reference.
- None of this reopens ADR-0007's identity decision. Points 1–2 change what
  goes *into* a slug, 3–4 change whether it may change, 5 closes a hole in
  the guarantee ADR-0007 relies on.

## Alternatives considered

**Transliterate non-Latin names into ASCII** (リリース計画 → `ririisu-keikaku`).
Rejected: it needs a per-script transliteration table, produces strings whose
authors often do not recognise them, and still collapses on scripts the table
does not cover. It also makes the slug look meaningful enough to be trusted,
which is the failure mode point 1 exists to avoid.

**Widen the slug charset to accept non-ASCII.** Rejected for now: slugs appear
in URLs, filesystem paths (`blobs/<workspaceId>/canvas/`), and export
filenames. Percent-encoding, NFC/NFD normalisation, and case-folding rules
differ across those three, and two spellings of the same name would resolve to
different canvases. This is a coherent long-term direction but it is a
project, not a clause in this ADR.

**Keep rename closed and rely on display names.** This is the status quo, and
it is defensible only while renaming looks expensive. The measurement above
removes that premise: the implementation exists, the internals are id-keyed,
and only external URLs are exposed — which point 4 addresses directly.

**Enforce sibling uniqueness by rejecting the merge.** Not possible: a CRDT
merge is not an operation anyone can decline.

**Reconcile duplicates by rewriting the tree on load.** This was the earlier
draft of point 5, and it is the more fragile answer: every peer mutates a
shared document as a side effect of reading it, so correctness rests on the
rewrite being perfectly idempotent and order-independent forever, and a bug
there corrupts rather than merely confuses. Deriving the disambiguation gets
the same user-visible result with no write, which is why Drive suffixes its
projection rather than its storage.
