# Vocabulary (always-on)

[ADR-0009](../../docs/contributing/adr/0009-mcp-tool-naming.md) fixed the
domain vocabulary. The codebase still speaks the old one in most places, and
this rule is how it converges without anyone scheduling a big-bang rename.

## The words

| word | means | does NOT mean |
|---|---|---|
| **Workspace** | the tree that holds documents; owns placement (`segment`, derived `alias`) and naming (display name) | anything about a document's content |
| **Document** | the unit a workspace contains. Has a kind | a canvas |
| **Facet** | OKF frontmatter (`type`, `tags`, extension `{domain}/{version}` buckets) | metadata on a JSON Canvas document — that concept does not exist yet |
| **Body** | an OKF document's markdown body | a spatial document's content |
| **Node** / **Edge** | JSON Canvas elements | anything in an OKF document |
| **Canvas** | the spatial surface, and the JSON Canvas format | the container a workspace holds — that is a Document |
| **OpenCanvas** | nothing. Retired — it was a working name for this project's document world, never a spec | the format (that is **JSON Canvas 1.0**) or the entity (that is a **Document**) |
| **Scene** | the laid-out projection of a spatial document (what `composeCanvasScene` produces) | stored content |
| **Version** | a saved point in a document's history | a branch |

Two consequences that catch people out:

- **A document's name lives in the workspace, not in its content.** OKF
  frontmatter `title` is a *projection* of the workspace display name on
  serialise, never a second place to write it.
- **Kind follows from the document.** There is no "read this document as
  OKF" for a JSON Canvas document. Cross-format output is an explicitly lossy
  projection (today: `wb_scene_render` for SVG), not a parameter on a read.

  ADR-0009 calls this a document's FORMAT while every implementation of it
  says `kind` — the daemon's column, the index row's field,
  `readDocumentKind`/`writeDocumentKind`, and the field each kind-carrying
  contract publishes. The ADR itself says the two are one concept ("Kind and
  format are already the same field") and criticises the codebase for
  spelling it both ways at once, so the fix was to pick one. **`kind` won**,
  because it was already everywhere the word is stored or published and
  `format` survived only in a `meta.ts` nothing imported (since deleted).
  `documentKindSchema` is the single source of truth.

## The standing rule

**When you touch a file, fix the vocabulary violations in what you touch.
Do not preserve backward compatibility for them.**

This is deliberate: the busiest code gets corrected first, because it is the
code people keep opening. Nothing schedules the rest, and that is fine — a
name nobody reads costs nobody anything.

Bounds, so this does not turn every change into a rename PR:

- Fix what your change already touches. Do not widen a diff to sweep a
  package you had no reason to open.
- A rename that crosses a package boundary or changes a published surface
  (`@kamiazya/whiteboard-mcp` tool names, URLs) is its own increment with its
  own review — not a drive-by. Everything internal is a drive-by.
- Say what you renamed in the commit message. A reviewer reading a diff that
  touches two subjects needs to know the second one was intentional.
- If a violation is load-bearing enough that fixing it in passing would
  obscure your actual change, leave it and say so rather than doing it badly.

Backward compatibility is not a consideration, and not only for internal
names. Every workspace package except one is **private**; only
`@kamiazya/whiteboard-mcp` publishes, and it is `0.0.x` with no users. A
deprecation alias buys nobody anything and doubles the surface that has to be
read.

That extends to STORED and PUBLISHED shapes — the JSON Canvas `x-whiteboard`
extension, the SQLite schema, tool parameters, URLs. Consistency of the model
outranks the reading of an old document or database, so a field is renamed
where a later version would have to migrate instead. Two consequences worth
knowing before doing it:

- A stored shape gets a MIGRATION where one is possible (`0009` renamed the
  whole DB schema without losing a row), and a plain break where it is not
  (`x-whiteboard.documentId` — a document exported under the old spelling
  loses its embed on read).
- A migration's own text is history and never renamed: its log key is
  recorded in the database, and every table and column it names is the name
  as it stood at that point in the log.

## Known violations, largest first

Not a work queue — a lookup, so you can recognise one when you open a file.

`Canvas` as the CONTAINER noun — once the largest entry here — is DONE, in
four increments (`switchDocument`, the `useDocumentSync` stack, the apps/web
UI surface, the browser stores, and the server contracts + HTTP routes).
`SpatialCanvas`, `CanvasEdge`, `CanvasColor`, `CanvasContextMenu`,
`CanvasDisplaySettings`, `CanvasViewer`, `canvasRef`, `screenToCanvas`,
`wb_canvas_tidy` and the render/layout helpers are CORRECT and stay: they name
the spatial surface, which is what the word means.

Four things about how it went are worth keeping.

**Order the increments by BOUNDARY, not by size.** `switchCanvas` went first
because it was the only name with no wrapper at all — zero `onSwitchCanvas`
props, no `useSwitchCanvas` hook — so renaming it left nothing calling it by
the old noun. But the `useCanvasSync` stack moved next as ONE increment
despite a six-member family, because every member lived inside `apps/web` and
none crossed a published subpath. So the rule is not "no family"; it is **no
member outside the increment's own boundary**. `listCanvases` and
`CanvasBackend` waited for their own increment for exactly that reason — both
were exported through `./api-contracts` / `./daemon-backend` / `./sse-backend`.

**A stored or published shape moves with a migration, or not at all.** The
apps/web IndexedDB stores went `canvases`/`loroCanvases`/`canvasFiles` ->
`documents`/`loroDocuments`/`documentFiles` and the pointer key
`defaultCanvasId` -> `defaultDocumentId` at DB_VERSION 6 -> 7. IndexedDB has
no rename, so each store is created, copied record by record, and the old one
DELETED once its cursor is exhausted — a store left in place keeps a second
copy of every document readable by anything that still remembers the name.
The HTTP surface moved in the same spirit and without a migration, since
server and clients ship together: `/api/workspaces/:ws/canvases/...` ->
`/documents/...`, `/api/w/:ws/canvas/...` -> `/document/...`, the browser
route `/w/:ws/canvas/:path` -> `/document/:path`, and the `canvases` array
key in three payloads (`wb_document_list`, the list response, the `/names`
response) -> `documents`.

**The old name is load-bearing in exactly two places, and a bulk rename
destroys both silently.** A migration's SOURCE names, and the fixtures that
seed a pre-migration database. Both happened here: one pass rewrote
`['canvases', 'documents']` to `['documents', 'documents']`, and another
rewrote every legacy fixture in `browser-idb-migration.browser.test.tsx` to
the new vocabulary — leaving the migration untested while every assertion
still passed. A third rewrote `/canvas/i.test(name)` in
`0009-document-vocabulary.test.ts`, inverting an assertion that no table is
still named for a canvas. Exclude `migrations/`, migration tests, and any
regex whose subject is the OLD word, then re-read the diff of what you did
exclude.

**What deliberately did NOT move.** The window-event VALUES stay
`'excalidraw:doc_changed'` and `'excalidraw:wb_version_saved'` —
`useDirtyState`, `HeaderBranchBanner`, `useBranches` and
`merge-committed-event` still match the raw strings, and
`document-sync-types.test.ts` pins both literals so a later rename cannot take
the wire format with it. User-visible UI copy still says "canvas" ("New
canvas", "Canvas actions"): what the product calls a thing to its users is a
product decision, not a code-vocabulary one, and this rule does not reach it.

**One container-noun use is still open, deliberately.** The wiki-link scheme
`[[canvas:<ULID>]]` (`CANVAS_ID_PREFIX` in `codec/src/references/resolve.ts`,
emitted by `resolve-for-export.ts`) names the container, so by this rule it
should be `document:`. It is left alone because it is the only one written
into a document's own free-text BODY: there is no schema to migrate, so
changing it silently breaks every link a user already typed. That is a
product decision about content, not a code-vocabulary one — decide it
explicitly rather than sweeping it.

One duplication surfaced and was NOT merged, because collapsing it changes
behaviour rather than names: three separate "not found" errors existed, two of
them meaning the same thing. `render/load-spatial-canvas.ts`'s is now
`SnapshotNotFoundError` (the alias `create-server.ts` had already given it),
`tools/document-crud.errors.ts`'s is `WorkspaceDocumentNotFoundError` (the
workspace index has no such document), and `tools/errors.ts` keeps
`DocumentNotFoundError` — which documents itself as "no saved snapshot", i.e.
the same condition as the first. `create-server.ts` maps classes to status
codes, so merging them is its own increment.

The four mis-prefixed package names are DONE: `@kamiazya/whiteboard-{model,
codec,ports,loro-adapter}`, with directories and vitest projects following.
`render` and `viewer` keep `canvas-` because they ARE about the spatial scene.

The fourth took two tries, and both wrong answers are worth knowing.
Dropping the prefix from `canvas-workspace` gives `workspace`, a domain noun
this rule defines as the tree that holds documents — and that package
explicitly knows nothing about placement. Its own comments came out reading
`workspace's withSpatialBatch`, indistinguishable from the dozens of correct
uses of the domain word around them. `crdt` fixed the collision but named a
technique rather than a role, and left the package's place in the
architecture unsaid.

`loro-adapter` names what it adapts. The distinction that settles it: this
package depends on `loro-crdt` and NOT on `ports` — it implements no port
and its whole production surface is one file, `loro-bridge.ts`. The store and
sync ports are implemented in the composition roots, so "adapter" here can
only mean an adapter of the vendor library, and the name says so. Renaming it
to suggest a port relationship would have stated the opposite of the
dependency graph.

`OpenCanvas` is retired and DONE outside the ADRs. It was never a spec: the
formats are OKF Markdown and [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/),
which `packages/model/src/spatial.ts` already cites by URL and the whole of
`packages/codec/src/spatial/` already spells correctly. `OpenCanvas` was this
project's working name for the post-Excalidraw document world — the thing
ADR-0009 named a **Document** — so the fix was mostly to DELETE the word, not
to substitute another spec name for it. It also collided with a real,
unrelated infinite-canvas interchange spec (OCIF, canvasprotocol.org), which
made it an actively wrong signal in the npm `keywords`.

Gone from: every published manifest (npm description + keywords, the Claude
and Codex plugin manifests, `server.json`, the Gemini extension), the READMEs
and user docs, one piece of user-visible UI copy (*"This workspace has no
OpenCanvas tree yet"*), and the internal identifiers
`registerOpenCanvasTools` -> `registerDocumentTools`, `opencanvas-tools.ts` ->
`document-tools.ts`, `createOpenCanvasServer` -> `createDocumentServer`.
ADR-0007/0008/0009 keep it and carry a dated vocabulary note instead, exactly
like `slug`: a decision record is history, and rewriting the reasoning would
misreport what was decided.

It gets no executable rung. `vocabulary-check.test.ts` would have to exclude
the ADR directory, and a guard that needs a carve-out to pass is one nobody
will trust the next time it fires. Same reason `canvas` will never qualify.
(The 178 `onOpenCanvas` handlers this note once listed as the OTHER carve-out
are gone — they are `onOpenDocument` now.)

The blob tree's path segment is DONE: `{dataDir}/blobs/{workspaceId}/canvas/`
is now `.../document/`, moved by migration `0012-document-blob-dir`. Two
things about it are worth knowing. It was recorded here as hardcoded by
"`document-store.ts` and `file-gc-sweeper.ts` both", and that was wrong —
the sweeper only mentions the layout in a comment and never joins the
segment, so the production surface was ONE line. And a migration can move
bytes on disk here, not just columns: `0008` already did, which is the
precedent `0011` follows. The end-to-end guard is
`migrator.legacy-upgrade.test.ts`, which seeds the OLD layout (that is what a
pre-0008 data dir looks like) and asserts the blob arrives under the new one,
so it proves the 0008 re-key and the 0011 move both ran, in order.

`slug` is retired outright, and `vocabulary-check.test.ts` in `tools/arch-lint`
is what keeps it retired — the one part of this rule that could stop being
prose. Adding a word there is only right when it has no legitimate meaning
left; `canvas` will never qualify, because it is correct for the spatial
surface and wrong only as the container noun.

MCP tool names (ADR-0009 point 5) are DONE, along with point 4's collapse of
the two exporters into a kind-branching `wb_document_get`. The registered
surface is `wb_<entity>_<action>` throughout, plus the MCP Apps UI tools
`canvas_open`/`canvas_view` that point 7 deliberately keeps.

Two more are done and worth knowing HOW, because both were fixed by removing
the place the wrong state could live rather than by correcting a call site:

- **A document's name stored twice.** `storedCoreFacetsSchema` omits `title`,
  so `writeCoreFacets` cannot be handed one and `readCoreFacets` does not
  surface one an older writer left. The name is the workspace's; OKF
  frontmatter `title` is projected from it on export and applied to it on
  import.
- **Core facets written to spatial documents.** `readCoreFacets` answers
  `undefined` for a document whose kind is `spatial`, and apps/web's spatial
  canvas row passes no facets at all rather than hiding the disclosure while
  still writing through it. A document with no kind is still allowed through,
  exactly as `wb_facet_set` allows one.
