# Vocabulary (always-on)

[ADR-0009](../../docs/contributing/adr/0009-mcp-tool-naming.md) fixed the
domain vocabulary. The codebase still speaks the old one in most places, and
this rule is how it converges without anyone scheduling a big-bang rename.

## The words

| word | means | does NOT mean |
|---|---|---|
| **Workspace** | the tree that holds documents; owns placement (`segment`, derived `alias`) and naming (display name) | anything about a document's content |
| **Document** | the unit a workspace contains. Has a kind | a canvas |
| **Facet** | a namespaced, versioned, schema'd attribute group attached to an object — key grammar `{namespace}.{name}/v{n}`, registered by a plugin at distribution time ([ADR-0013](../../docs/contributing/adr/0013-facet-system.md)). OKF core frontmatter (`type`, `tags`) stays a markdown-document concern | a runtime-definable schema, or anything with a privileged "core" namespace — no facet is core; only the engine is |
| **Body** | an OKF document's markdown body | a spatial document's content |
| **Node** / **Edge** | JSON Canvas elements | anything in an OKF document |
| **Canvas** | the spatial surface, and the JSON Canvas format | the container a workspace holds — that is a Document |
| **OpenCanvas** | nothing. Retired — it was a working name for this project's document world, never a spec | the format (that is **JSON Canvas 1.0**) or the entity (that is a **Document**) |
| **Scene** | the laid-out projection of a spatial document (what `composeCanvasScene` produces) | stored content |
| **Version** | a saved point in a document's history | a branch |
| **Browser** / **Daemon** | who KEEPS a workspace — the browser's own storage, or the whiteboard daemon | a claim about network locality; both run on the same machine |
| **Comment** | the annotation layer's unit (ADR-0024/0025/0026): anchored feedback about a spot or node, floating above content. A **thread** is the anchored unit and comments are its messages | content — never tidied, never part of what the document says. Says nothing about EXPORT, which ADR-0026 decision 1b decides; "annotation layer" in user copy; "History"/"Archived"/"Done" for resolved |

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
  render/layout helpers, and the MCP Apps UI tools. The word means the
  surface; only the CONTAINER sense was retired.

  This entry no longer lists tool NAMES. A rule that names a tool is one more
  place a rename has to reach, and it had already gone stale here — the same
  reason the guidance the server hands to clients names none either. The
  registered list is `ALL_REGISTERED_TOOLS` in `mcp-smoke-coverage.ts`.
- **Judge by the RETURN TYPE, not the owner.** `documentSyncSession.getCanvas()`
  answers with a `SpatialCanvas`, so `Canvas` is correct even though a
  document-shaped object owns the method.
- **Window-event VALUES** are `'whiteboard:doc_changed'` /
  `'whiteboard:wb_version_saved'` / `'whiteboard:merge_committed'`, and the WS
  subprotocol is `'whiteboard-v1'`. The `excalidraw:*` / `excalidraw-v1`
  spellings were retired in one coordinated rename (2026-08-28, 0.0.x
  no-compat policy): window events never leave the bundle and are not
  persisted, and both ends of the WS subprotocol ship from this repo — a
  stale cached bundle fails the handshake until it updates, which is the
  accepted cost. `document-sync-types.test.ts` still pins the event values so
  a PARTIAL rename cannot split the four modules that match the raw strings.
  What still legitimately spells `excalidraw`: assertions about foreign
  formats (`.excalidrawlib` packs, the Excalidraw clipboard payload), the
  sbom/import guards proving the old deps stay gone, and history in ADRs.
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

## The keeper axis, and why `local` was never on it

A workspace is KEPT by something: today the browser's own storage or the
whiteboard daemon, later a self-hosted or SaaS backend. **`Browser` and
`Daemon` name the keeper.** They are not modes and not an exclusive pair —
the intended model is that connecting a daemon PROMOTES a workspace's source
of truth to it, with everything below becoming a replica.

Both halves of that model are implemented (ADR-0023). The MOVE: Settings >
Connections' "This workspace" section (`components/settings/
PromoteWorkspaceSection.tsx` over `lib/promote-workspace.ts`) transfers the
browser's whole workspace record into a daemon workspace as a CRDT merge —
identity, history and referenced images survive, and path collisions
surface as shadowed. The DEMOTE (2026-09-04): once every document and
image is VERIFIED on the daemon — read back from this browser's own
replica, not from the response — the old browser record is deleted
(`lib/demote-browser-workspace.ts`); what remains is a cached replica under
the daemon workspace's id, read-only when the daemon is unreachable. An
unverified move keeps the browser copy and says so. Copy may
therefore say "kept by the daemon, cached here" after a verified move;
continuing from the daemon is still a narrated reload the user takes, never
a silent source-of-truth swap. The older per-document import panel, which
preserved no document identity, is DELETED (user decision, 2026-08-28) —
the whole-workspace move is the only browser-to-daemon transfer.

`local` was the wrong word for this axis and could never have been the right
one, because **a daemon is local too**. Two names spelled it that way and
meant opposite things — `browser-local` (kept in the browser) and
`local-daemon` (kept by the daemon) — which is as confusable as a pair gets,
and it was visible: the chip read `Local` while its own popover said "Connect
a local daemon".

`local` is therefore NOT retired, and cannot be. It still means "on this
machine rather than remote", which is its correct sense in `localhost`, in
`Local Network Access` (a W3C spec name), in `local-network-gate.ts`, and in
`packages/mcp-server`'s `authMode: 'local-daemon'` — whose opposite is
`'server-mode'`, making it exactly the network sense. Only `local` used for
WHERE A WORKSPACE IS KEPT is retired.

`vocabulary-check.test.ts` pins the browser half in EVERY casing
(`/browser[-_]?local/i` — so `browser-local`, `browserLocal`, `BrowserLocal`,
`BROWSER_LOCAL` and `browserlocal` alike), across `apps/web/src`,
`apps/web/scripts`, `docs`, `.github`, `.claude`, and the root `README.md`
and `apps/web/DESIGN.md`. The daemon half is pinned over the same surface,
but only in its IDENTIFIER casings (`/local_?daemon/i` — `localDaemonBaseUrl`,
`LOCAL_DAEMON_*`), because the hyphenated `local-daemon` is still CORRECT in
its network sense and always will be: `packages/mcp-server`'s
`authMode: 'local-daemon'` opposite `'server-mode'`, the
`connect-to-local-daemon` how-to, the `config-file-local-daemon` anchor. A
daemon on this machine really is local. The quoted VALUE `'local-daemon'`
stays banned in `apps/web/src` alone, since in mcp-server that same string is
the auth mode.

The scan is that wide because a hand grep kept missing places, three times in
one increment: `claimIsolatedWhiteboardDb('browserlocaldocumentpage-…')` had
no separator for a `browser-local` grep to match on; `testing.md` spelled it
camel-cased; and the workflow that posts a preview-URL comment on every PR
said "Browser-local mode" in a `.yml` nothing scanned. Prose is where this
word decays, so prose is what the guard reads.

`migrations` and `adr` are excluded as history, and THIS FILE is exempt — it
is the one place that has to spell the retired words in order to retire them.

Nothing is left unclaimed. The last increment was the persisted settings key
`localDaemonBaseUrl`, which became `daemonBaseUrl` under a real migration
rather than a sweep — the store reads `whiteboard:user-settings:v2` and falls
back to migrating the `:v1` key exactly once when v2 is absent.

Why it could not be a sweep, measured rather than argued: the schema is
`.strict()` and the loader falls back to defaults on ANY parse failure, so
renaming the key in place discards an existing reader's WHOLE payload —
daemon URL, known and dismissed daemons, theme, fonts — not merely the daemon
connection. A sweep did exactly that earlier in this work, and the loss was
invisible because nothing reads `preferredProvider`.

Two fields went in that migration rather than through it. `preferredProvider`
and `lastBrowserCanvasId` were read and written by nothing, so they are
dropped: a field nobody reads does not need a better name. `lastBrowserCanvasId`
was also the last `canvas`-as-container-noun in a stored shape, retired by
deletion instead of a rename.

`user-settings-store.ts` and its test are therefore exempt from the daemon
guard, for the reason a migration always is: spelling the old key is how they
read a payload written under it.

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
