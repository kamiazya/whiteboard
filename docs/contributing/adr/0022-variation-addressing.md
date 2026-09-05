# ADR-0022: A variation is not in the address, and the default one has no name to put there

**Status:** Accepted — decision 2 revisited on 2026-09-05 (see the dated note); decision 1 unchanged

## Context

Three things a session is "in" can be told apart by asking what names them:

| layer | named by | where that name lives |
|---|---|---|
| Workspace | segment, or the canonical id | the URL ([ADR-0019](0019-workspace-identity.md)) |
| Document | path | the URL |
| **Variation** | branch name | **the daemon's HEAD for that document** |

The first two follow ADR-0019's rule that the URL is the only runtime truth.
The third does not, and this was never decided — it is what fell out of
building variations on a branch API.

What that means today, read off the code rather than assumed:

- Switching a variation is `PUT` to the document's `head` route
  (`useBranches`' `setHead`). It changes what the document IS, for everyone
  looking at it, not what this reader is looking at.
- No URL can name a variation. There is no way to link someone to one, and
  no way for a reload to return to one — reload lands on whatever HEAD says
  at that moment, which may be a variation this reader never chose.
- Variations exist only under the daemon keeper. The browser keeper has no
  branch API, which is why the connect copy offers "version history,
  variations and merging" as things a daemon adds.

> **Note (2026-09-05): that third bullet has expired.** The browser keeper
> keeps its variations on the workspace record and combines them, through the
> same `packages/history` mechanics the daemon runs; nothing about a variation
> is a daemon concept any more, and the per-keeper capability map that said so
> is gone (see [ADR-0004](0004-unified-capability-gated-canvas-page.md)'s
> addendum of the same date). Neither decision below is affected — they are
> about the ADDRESS, which is the same grammar whoever keeps the document.
>
> What has NOT followed yet: `?v=` is supplied only by `DaemonDocumentPage`,
> even though the browser backend answers `loadDocument` for a named
> variation. So a browser-kept variation can be switched and combined but not
> yet linked to. That is a gap in the page wiring rather than in this
> decision, and it is recorded as one.

The open question was the grammar: if a variation ever becomes addressable,
does the DEFAULT one appear in the address?

## Decision

**A variation does not appear in the URL, and the default variation has no
ref at all.**

Two halves, and they are separate claims:

1. **The default variation carries no ref.** It is the unnamed one. An
   address with nothing said about variation means the default, the way
   `/w/<workspace>/d/<path>` already reads. `main` is the identifier the
   store happens to use; it is not a thing an address says.
2. **No variation goes in the URL for now**, default or otherwise. The
   address grammar stays `/w/<workspace>/d/<path>`, and the current
   variation stays the daemon's HEAD.

Decision 1 is the durable one: whatever addresses a variation later — a URL
segment, a query parameter, something else — the default is never decorated.
Decision 2 is a scope decision for now and may be revisited; decision 1
constrains what revisiting it may look like.

> **Note (2026-09-05): decision 2 revisited — a non-default variation is now
> addressable, as a READ-ONLY view.** `?v=<name>` on a daemon document's
> address opens that variation's tip through the same read-only projection
> version previews use (`GET .../branches/:name/document`), without moving
> HEAD. Sharing and bookmarking a variation work; switching stays a shared
> act behind an explicit control on the preview banner, which also carries
> the combine lead-in. Decision 1 held exactly as written: the default is
> never decorated — `?v=main` strips back to the plain address (even while
> HEAD is elsewhere), and so does a `?v` naming the current HEAD, so there
> is still exactly one address for the page a plain URL means. The rejected
> per-reader EDITING variation stays rejected; a per-reader read-only VIEW
> is what shipped, and it is a different thing — nothing anyone draws lands
> in it.

## Consequences

Easier:

- The common address stays short and stable. A document's URL does not
  change when someone makes a variation, and does not need rewriting when a
  variation is deleted or renamed.
- There is one address for a document, so nothing has to decide whether two
  URLs naming the same document through different variations are the same
  page — for caching, for the service worker, for `documentPath`, or for a
  reader.
- No migration: this records the shape that already ships.

Harder, and these are real:

- **A variation cannot be shared or bookmarked.** Sending someone a link
  sends them to the document, and they see whatever HEAD points at.
- **Switching is a shared act.** One person switching moves the document for
  everyone on it. That is a coordination property, not a viewing preference,
  and the UI must keep saying so — the chip names the current variation
  precisely because it is not private.
- **Reload does not return to a variation.** Whatever a reader was looking
  at is only theirs until someone moves HEAD.

The second and third are the cost of decision 2, not of decision 1. If they
become the wrong trade, the fix is to make a variation addressable — and
decision 1 already says what that must look like for the default.

## Alternatives considered

**Put every variation in the URL, including the default**
(`/w/<ws>/d/<path>/v/main`). Rejected: it decorates the overwhelmingly
common case to serve the rare one, and it makes two spellings of the same
page — `.../path` and `.../path/v/main` — which then have to be declared
equivalent everywhere something keys on a URL. ADR-0019 rejected the same
shape for workspaces, where a canonical id is a valid handle but the segment
is what an address shows.

**A per-reader variation, held client-side.** Rejected as a different
product: variations here are a coordination feature with merging, and a
reader privately on a variation nobody else can see would make "combine
from another variation" mean something else. It is also not what the branch
API implements — HEAD is one pointer per document.

**Decide nothing until variations are addressable.** Rejected because the
question is cheap to answer now and expensive later: by the time a URL
carries variations, the default's spelling is already load-bearing in links
people have sent each other.
