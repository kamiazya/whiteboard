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

## Correct uses that look like violations

ADR-0009's vocabulary has landed: no known violation is open. What is left is
the opposite lookup — the places `canvas` and the old spellings are RIGHT, so
a later sweep does not "fix" them.

- **The spatial surface.** `SpatialCanvas`, `CanvasEdge`, `CanvasColor`,
  `CanvasViewer`, `canvasRef`, `screenToCanvas`, `wb_canvas_tidy`, the
  render/layout helpers, and the MCP Apps UI tools `canvas_open`/`canvas_view`.
  The word means the surface; only the CONTAINER sense was retired.
- **Judge by the RETURN TYPE, not the owner.** `documentSyncSession.getCanvas()`
  answers with a `SpatialCanvas`, so `Canvas` is correct even though a
  document-shaped object owns the method.
- **Window-event VALUES** stay `'excalidraw:doc_changed'` /
  `'excalidraw:wb_version_saved'`; four modules match the raw strings and
  `document-sync-types.test.ts` pins both so a rename cannot take the wire
  format with it.
- **User-visible copy** ("New canvas", "Canvas actions"). What the product
  calls a thing to its users is a product decision this rule does not reach.
- **Assertions ABOUT the old word.** `resolve.test.ts` still writes
  `[[canvas:<ULID>]]` — it exists to prove that spelling has no meaning left.
  `model/src/spatial.ts` comments that a format saying `canvasId` teaches the
  wrong thing. Rewriting either inverts what it says.
- **Migrations, their fixtures, and the ADRs.** Each names the shape as it
  stood at its point in the log. ADR-0007/0008/0009 keep `slug` and
  `OpenCanvas` behind a dated note: a decision record is history, and
  rewriting the reasoning would misreport what was decided.

`slug` is the one word retired outright, and `vocabulary-check.test.ts` in
`tools/arch-lint` keeps it retired — the only part of this rule that is not
prose. Add a word there only when it has no legitimate meaning left. `canvas`
never will, and `OpenCanvas` cannot either: the guard would need an ADR
carve-out, and a guard that needs one is a guard nobody trusts when it fires.

## Renaming a stored shape

The mechanical half is easy and the traps are not. Everything below cost a
real defect at least once.

- **Order increments by BOUNDARY, not by size.** A six-member family inside
  one package is one increment; a single name exported through a published
  subpath is its own. The question is not "how many call sites" but "does any
  member leave this increment's boundary".
- **Check first whether the shape is on its way out.** A name you are deleting
  does not need to be right, and moving it can break the deletion — a blob-tree
  rename was written, tested, and WITHDRAWN because a sweeper that reads the
  old literal would have been left walking an empty directory.
- **The old name is load-bearing in exactly two places**, and a bulk rename
  destroys both silently: a migration's own SOURCE names, and the fixtures that
  seed a pre-migration database. The check is
  `git diff origin/main -- .../migrations/` coming back empty — not an
  exclusion list, which a merge resets. The same trap bites plain tests: a
  fixture asserting the OLD word is load-bearing too.
- **A boot-time writer can undo a migration.** `prepareDataDir` runs migrations
  and THEN re-invokes `importFsBlobs`, so a routine still holding the old
  literal re-seeds rows the migration just corrected. Pass the prefix as a
  parameter: the migration passes the value it was RECORDED with, the boot path
  passes the live one.
- **`pragma defer_foreign_keys` fails misleadingly.** It reads back as `1` and
  the UPDATE still raises `FOREIGN KEY constraint failed`, because the pragma
  only has effect inside an explicit transaction and kysely's Migrator does not
  open one. Rewrite structurally instead — copy under the new key, then delete
  the old parent and let `on delete cascade` take its children — so every
  statement is valid on its own.
- **After a rename lands, re-grep for what TOUCHES it**, not for the word you
  replaced. Four increments retired the container noun and each left the verbs
  and helpers wrapped around it (`canvasPath` building a `/document/` route,
  `listCanvasesV1` fetching a `documents` key). Search `get*`, `list*`,
  `*Path`, `*Url`.
- **Mutation-check the guard, and check the fixture reaches it.** A test that
  pinned "rewrite only the prefix" seeded a key the `like 'canvas:%'` filter
  excluded outright, so swapping `substr` for a blanket `REPLACE` left it
  green. A fixture for a SET expression has to survive the WHERE clause first.

Two invariants were fixed by removing the place wrong state could live, rather
than by correcting a call site — keep them that way:

- `storedCoreFacetsSchema` omits `title`, so a document's name cannot be
  written twice. OKF frontmatter `title` is projected from the workspace name
  on export and applied back on import.
- `readCoreFacets` answers `undefined` for a `spatial` document, so core facets
  cannot be written to one.
