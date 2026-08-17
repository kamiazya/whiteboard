---
name: auditing-workspaces
description: Audit a whiteboard workspace's documents to find likely-stale or duplicate spatial canvases before creating new ones. Use when a workspace has been in heavy use and you want to check for clutter, or you want a quick sense of what a document actually contains before opening it.
---

# auditing-workspaces

List a workspace's documents, then use the spatial ones' scene digests to judge which look empty
or abandoned. There is no server-side audit endpoint — this skill is a recipe for composing the
regular document tools toward that end, nothing more.

For the main drawing workflow, see the drawing-visuals skill in `skills/drawing-visuals/SKILL.md`.

---

## When To Use It

- When a workspace has been in heavy use and you want a sense of what is in it before adding more
- When you want to check for a likely-duplicate path before calling `wb_document_create`
- When you want to know whether a spatial document is worth opening without rendering it

---

## Execution Flow

### Step 1: List The Workspace's Documents

```js
wb_document_list({ workspaceId })
```

Returns `{ canvases: [{ documentId, path, name? }] }` — placement only, no content. An unknown
`workspaceId` is an error here, not an empty list, so a typo reads as a failure rather than "nothing
found."

### Step 2: Classify, Then Sample Each Document

Step 1's listing carries no `kind`, and `wb_document_get` is the only tool that reports one — so
classification comes first, and it costs one `wb_document_get` per document:

```js
wb_document_get({ workspaceId, documentId })
// markdown -> { kind: "markdown", content: "...", frontmatter: {...} }  (the body, directly)
// spatial  -> { kind: "spatial", content: "..." }                        (full JSON Canvas payload)
// no recorded kind -> throws a "no recorded kind" error — itself a signal worth reporting
```

**Do not probe with `wb_scene_digest` first.** The digest reads the spatial containers without
checking the document's kind, so a markdown document — whose body lives elsewhere — digests as
`{ nodes: [], edges: [] }` with no error. Digest-first therefore cannot distinguish "empty spatial
document" from "markdown document full of prose."

Once a document is KNOWN spatial (from `wb_document_get`'s `kind`, or because this session created
it), `wb_scene_digest` is the cheap re-probe for later passes — counts and bounding boxes without
re-pulling the payload:

```js
wb_scene_digest({ workspaceId, documentId })  // only meaningful for a known-spatial document
```

A document with no recorded kind predates format tracking (`wb_document_get` refuses; the digest
still answers, misleadingly, from the empty spatial containers). The only way to give it a kind is
to write to it (`wb_node_add`/`wb_node_patch`/`wb_edge_patch` records `spatial`, `wb_document_set`
records `markdown`).

### Step 3: Judge Staleness

There is no last-modified or last-accessed timestamp exposed through these tools. Judge staleness
structurally instead:

| Signal | How To Check | Likely Meaning |
| --- | --- | --- |
| empty spatial document | `kind` is `spatial` (Step 2) AND digest reports zero nodes | never drawn, or already redrawn elsewhere — candidate for `wb_document_delete`. A zero-node digest ALONE proves nothing: markdown documents always digest empty |
| near-duplicate path | two `wb_document_list` entries with similar `path`/`name` | probably one abandoned in favor of the other |
| markdown document with an empty body | `content` is blank apart from frontmatter | scaffolded but never written |
| document with no recorded kind | `wb_document_get` throws the "no recorded kind" error | predates format tracking; needs deciding, not deleting on sight |

### Step 4: Write The Report

Keep the user-facing summary short and structured:

```text
## whiteboard audit report — workspace {workspaceId}

Documents: {N}
Empty or near-empty: {list of path -> documentId}
Likely-duplicate paths: {pairs}
No recorded kind: {list}

### Deletion candidates
- {path} ({documentId}): {reason}
```

Do **not** delete anything automatically. Always confirm with the user before calling
`wb_document_delete`.

---

## Notes

- `wb_document_delete` fails if other documents sit below the target's path — deletion is refused
  rather than silently cascading, so report the blocker back to the user instead of retrying
  differently.
- Deletion is not recoverable through these tools beyond a document's own saved versions
  (`wb_version_list` / `wb_version_restore`), and those do not survive the document itself being
  deleted.
- This skill has no bulk operation: auditing N documents means N `wb_document_get` /
  `wb_scene_digest` calls. For a very large workspace, sample rather than exhaustively walking
  every document.
