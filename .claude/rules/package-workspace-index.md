# workspace-index — the DocumentIndex port over a workspace's Loro tree

## Why it is its own package

It needs BOTH `ports` and `loro-crdt`, and no existing package may hold both:
`loro-adapter` is deliberately closed to `ports` (it implements no port), and
`ports` is deliberately closed to `loro-crdt` (it is contracts only).
`server-core` has both but `apps/web` cannot import it — that would pull hono
and the whole MCP tool surface into the browser bundle.

The alternative was one implementation per composition root. That is the
existing pattern for this port — in-memory, libSQL and IndexedDB — but those
three differ because their STORAGE differs. Two tree-backed ones would differ
in nothing: same tree, same functions, ~200 lines duplicated with no reason
for the duplication to exist.

## What belongs here

- `LoroWorkspaceDocumentIndex`: the port's ordering promise
  (`compareDocumentPaths`), its error taxonomy, and the collision rules a CRDT
  does not enforce on its own.
- `WorkspaceDocs`: the seam for where a workspace's document comes from and
  where a change to it goes.

## What does NOT belong here

- The tree itself — reading, writing, moving, deleting nodes — which is
  `loro-adapter`'s `workspace-tree.ts`. This package composes those primitives
  into the port; it does not know how a `LoroTree` works.
- Where the bytes live. `WorkspaceDocs` exists precisely so this package never
  learns about libSQL or IndexedDB.

## Dependency rules

- Runtime: `model`, `ports`, `loro-adapter`, `loro-crdt`.
- Forbidden: `node:*`, DOM globals, `inversify` — it runs in both roots.
- Enforced by `tools/arch-lint`. **Registering a package in
  `architecture-map.ts` does NOT scan it**: it must also be listed in
  `repo-coverage.test.ts`'s `SHARED_LAYER_PACKAGES`. Verified here the same
  way the comment there records for `plugin-visual` — a `node:fs` import
  passed a full arch-lint run until the package was added to that list.

## Conventions

- **Folders are nodes.** A row-backed index can hold `a/b` with nothing at
  `a`; a tree cannot, because `b` needs a parent. So `a` becomes a folder — a
  node with a segment and no document. Folders never appear in
  `listDocuments`, and an empty one is pruned, because it exists only to hold
  a descendant.
- **A folder at a destination is not a collision.** It is scaffolding, and a
  move that empties it may take its place. Without that, `a/b` -> `a` is
  refused, which the port says must succeed — the one case where the tree
  model would otherwise be strictly weaker than the row model.
- **`createDocument`'s path check is LOCAL and says so.** After the workspace
  tree, path uniqueness cannot be a global invariant: two replicas can create
  one path and both survive the merge. The check stops one user on one device,
  which is the ordinary case, and claims nothing more.
- Mutations are serialised per workspace. The port asks for it in so many
  words, and a check-then-write pair is two steps here.
- **Delete evacuates BEFORE it removes**, and the order is the whole
  guarantee. A deleted tree node cannot be moved back and a shallow snapshot
  drops its content, so nothing in the live document can serve as the copy
  afterwards. Export failing leaves the document there to try again; the other
  order leaves nothing to try again with. Mutation-checked — reversing it
  fails three of the four trash tests.
- `BlobStore` is a REQUIRED constructor argument for the same reason. An
  optional evacuation is one a caller can forget to wire, and forgetting does
  not degrade a feature — it destroys the document.
- Restore is a COPY under the same `documentId`. The `TreeID` is new because
  Loro will not revive a deleted one; keeping the documentId is what makes
  that invisible to a share link.

## Tests

- Vitest project: `workspace-index-node`.
- Held to `describeDocumentIndexConformance` — the same 22 cases the in-memory,
  libSQL and IndexedDB indexes pass. That is the evidence that a tree can keep
  the port's promises, as opposed to a comment claiming it.

## Common mistakes (append as review finds them)

- Counting a folder as an occupied path in a move's collision check.
- Sorting in `loro-adapter` instead of here. `readWorkspaceDocuments` answers
  in TREE order on purpose; the port's order is this package's promise.
