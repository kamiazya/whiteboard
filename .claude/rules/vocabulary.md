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
names. Every `@kamiazya/whiteboard-canvas-*` package is **private**; only
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

- `canvas-store.ts` (mcp-server's daemon-side file/db store) — `CanvasDocStore`
  and `canvas-doc-io.ts` are done
- The `@kamiazya/whiteboard-canvas-{model,codec,render,ports,workspace,viewer}`
  package names — `render` and `viewer` are arguably correct (they are about
  the spatial scene); `model`, `codec`, `ports` and `workspace` are not
- MCP tool names — ADR-0009 point 5, its own increment

Two are done and worth knowing HOW, because both were fixed by removing the
place the wrong state could live rather than by correcting a call site:

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
