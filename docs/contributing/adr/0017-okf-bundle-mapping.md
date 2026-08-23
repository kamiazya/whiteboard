# ADR-0017: Mapping a workspace onto an OKF bundle

**Status:** Proposed — design only, not implemented

## Context

OKF's unit of distribution is a **directory**, not a file: a Knowledge Bundle
is a tree of markdown documents with two reserved filenames, `index.md` and
`log.md`, and everything else a concept
([SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
§3). This project exports one document at a time — the
`/api/v1/workspaces/:workspaceId/documents/:documentId/okf` route and
`wb_document_get` — so what it produces today is a conformant *concept*, never
a bundle.

Most of the mapping is already available. A workspace is a tree; a document
has a path and a display name; ADR-0009 already settled that the frontmatter
`title` is a projection of the workspace name rather than a second copy. What
is missing is a decision about the parts a workspace has no direct equivalent
for, and about the parts where this project's conventions and OKF's disagree.

This ADR fixes that design. It deliberately does not implement it.

## Decision

### 1. A concept ID is the workspace path

OKF §2 defines a concept ID as the file's path within the bundle with `.md`
removed. The workspace tree's path is already exactly that, so the mapping is
identity and nothing new needs to be stored. Display name continues to project
to frontmatter `title` on the way out and to apply back on the way in
(ADR-0009 decision 2), including its two pinned edge cases: absent is not
cleared, and a blank title is no title.

### 2. Export rewrites wikilinks into bundle-relative markdown links, and
import learns to read them back

OKF §6.1 links concepts with **standard markdown links**, recommending the
bundle-relative form (`[customers](/tables/customers.md)`) because it survives
a document moving within its subdirectory. This project links with
`[[wikilink]]`. Emitting `[[…]]` into a bundle would ship a private syntax
that a generic OKF consumer renders as literal text — the opposite of the
point of adopting an open format.

The seam for this already exists and has been waiting for a caller:
`resolveReferencesForExport` in `codec/references` rewrites `wikiLink`/`embed`
nodes into plain markdown links through an **injected** id→path resolver,
leaves an unresolved id as literal `[[ID]]` so the pass is idempotent, and is
tested but called from nowhere in this repo. Bundle-relative output is
therefore only a question of what the resolver returns.

The asymmetry this creates must be closed on the import side or a whiteboard
bundle re-imported into a whiteboard silently loses every backlink: ADR-0014's
extraction learns bundle-relative markdown links as a third `via` alongside
`wikilink` and `embed-node`. That is additive, and independently worth having —
it is also what gives a bundle authored by someone else a Connections view.

### 3. `index.md` is generated on export and never stored

One per directory, built from each child's name and `description`, per §8. It
carries no frontmatter, with the single exception §8 and §12 allow: the bundle
root's `index.md` declares `okf_version: "0.2"`.

It is regenerated on every export rather than kept as a document, because a
stored index is a second copy of the workspace tree, and a second copy goes
stale — the same argument that keeps `title` out of storage.

On import, `index.md` and `log.md` are read as structure and **not** imported
as documents: §3.1 reserves both names, so a bundle that round-trips through a
workspace must not grow two concepts named after them.

### 4. `log.md` is not exported, and the reason is that it would lie

§9's log is per-directory and made of dated prose entries describing what
changed. What this project has is per-document version records —
`{ label, timestamp, frontier }` — with no directory scope and no description.
Synthesising `## 2026-08-23` / `* **Update**: v1` from that produces a file
shaped like a history that tells a reader nothing they could act on.

`log.md` is optional (§3, §8), so omitting it is conformant and fabricating it
is not. Revisit when a saved version carries a message.

### 5. A spatial document is written as its `.canvas` file, not as a concept

§3.1 says every non-reserved `.md` file is a concept document. A `.canvas`
file is simply not one — which is legal, and truthful about what a JSON Canvas
document is. It gets an `index.md` entry so a reader finds it.

The alternative, a concept stub carrying `resource:` pointed at the sibling
file, invents a convention OKF does not define, and ADR-0009 decision 4
already settled that a cross-format projection is explicitly lossy and lives
apart from the document's own format.

### 6. Import is permissive, because §11 requires it

A consumer MUST NOT reject a bundle for missing optional fields, unknown
`type` values, unknown frontmatter keys, broken cross-links, or missing
`index.md`. Unknown keys are already handled — they land in `facetsRaw`, which
is what the preservation fix bought. A bare `verified` mapping MUST be read as
a one-element list (§5.2).

Missing or empty `type` is the one conformance failure, and it fails **that
file**, not the bundle: the import reports the file it could not read and
carries on with the rest. Refusing a whole directory because one document is
malformed is the behaviour §11 spends its length arguing against.

`okf_version` is read and reported, never gated on — §12 asks consumers that
do not understand a declared version to attempt best-effort consumption.

### 7. A directory is the form; a zip is a permitted transport

§3 allows a bundle to be distributed as a git repository, a tarball, or a zip.
That matters concretely here because the two composition roots have different
capabilities: the daemon can write a directory, and `apps/web` has no
filesystem to write one into. So the browser producing a zip and the daemon
producing a directory are the same bundle in two permitted packagings, not two
formats — and neither needs its own mapping decision.

## Consequences

- Export becomes a workspace-level operation with a surface of its own. The
  per-document `/okf` route stays; it answers a different question.
- An exported bundle's markdown is not byte-identical to the body stored in
  the whiteboard, because the links were rewritten. That is a projection, in
  the same sense `title` is one, and it should be documented where users read
  about export rather than only here.
- A whiteboard backlog can leave the machine as a directory of plain markdown
  and come back — which is the first thing the local-private ticketing flow
  has ever had that is not "it lives in this one daemon".
- Nothing here depends on ADR-0016 landing first. A bundle exported before the
  trust family exists simply carries no `generated`, which is a conformant
  bundle.
- `index.md` generation needs a `description` to be worth reading. That was
  listed here as an open prerequisite and has since landed: `description` is a
  modelled core facet, edited in the properties panel as "Summary", so an index
  built from it is a list of summaries rather than of bare titles.

## Alternatives considered

**Emit `[[wikilinks]]` unchanged.** Rejected: a private syntax inside an open
format, rendered as literal text by every consumer that is not this project.

**Emit both a wikilink and a markdown link.** Rejected: doubles every
reference in the reader's view to avoid making one decision.

**Store `index.md` as a real document in the workspace.** Rejected: a second
copy of the tree, which drifts the first time a document is renamed outside an
export.

**Synthesise `log.md` from version records.** Rejected, see decision 4.

**Export a spatial document as a concept whose `resource:` names the `.canvas`
file.** Rejected: invents a convention, and dresses a diagram up as knowledge
prose.

**Treat the whole workspace as one flat bundle root, ignoring directories.**
Rejected: the tree is the part of a workspace an OKF bundle can represent
natively, and flattening it would throw away the only structure both models
already agree on.
