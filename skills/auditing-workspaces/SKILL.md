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

Returns `{ documents: [{ documentId, path, name?, kind?, updatedAt?, shadowed? }] }` — placement only, no content. An unknown
`workspaceId` is an error here, not an empty list, so a typo reads as a failure rather than "nothing
found."

### Step 2: Classify, Then Sample Each Document

Step 1's `kind` is the cheap classification, and it is `optional` for a real reason: a document
whose index row never recorded one has no `kind` in the listing. That absence is itself the
signal — it is the pre-kind case Step 3 asks about, spotted without reading anything.

Content still needs `wb_document_get`, but that is ONE call for up to 20 documents:

```js
wb_document_get({ workspaceId, documentIds: [a, b, c] })
// -> { documents: [...], failed: [...] }
// markdown -> { documentId, kind: "markdown", content: "...", frontmatter: {...} }  (the body, directly)
// spatial  -> { documentId, kind: "spatial", content: "..." }                        (full JSON Canvas payload)
// no recorded kind -> an entry in `failed` with the reason — it does not take the batch with it
```

`documents` comes back in the order asked for, minus anything in `failed`, so read `failed` rather
than assuming the two arrays line up.

**Read the kind before reading the content.** A spatial read refuses a document it knows to be
markdown rather than reporting its containers as empty, so it cannot silently answer "nothing
here" about a document full of prose — but it also cannot tell you the kind of a document you have
not identified yet. Step 1's `kind`, or `wb_document_get`'s, is what establishes that.

Once a document is KNOWN spatial (from `wb_document_get`'s `kind`, or because this session created
it), `wb_canvas_snapshot` is the cheap re-probe for later passes — node text, geometry and lock
state without the untruncated JSON Canvas payload:

```js
wb_canvas_snapshot({ workspaceId, documentId })               // what is on it
wb_canvas_snapshot({ workspaceId, documentId, layout: true })  // ...and whether it is tidy
```

A document with no recorded kind predates format tracking (`wb_document_get` reports it in
`failed` rather than guessing; the digest still answers, misleadingly, from the empty spatial
containers). The only way to give it a kind is
to write to it (a `wb_canvas_edit` call records `spatial`, `wb_document_set` records `markdown`).

### Step 3: Judge Staleness

There is no last-modified or last-accessed timestamp exposed through these tools. Judge staleness
structurally instead:

| Signal | How To Check | Likely Meaning |
| --- | --- | --- |
| empty spatial document | `kind` is `spatial` (Step 2) AND digest reports zero nodes | never drawn, or already redrawn elsewhere — candidate for `wb_document_delete`. A zero-node digest ALONE proves nothing: markdown documents always digest empty |
| near-duplicate path | two `wb_document_list` entries with similar `path`/`name` | probably one abandoned in favor of the other |
| markdown document with an empty body | `content` is blank apart from frontmatter | scaffolded but never written |
| document with no recorded kind | no `kind` in the Step 1 listing, and a `failed` entry from `wb_document_get` | predates format tracking; needs deciding, not deleting on sight |

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
  (`wb_version_list` / `wb_version_restore`) — the same history the History panel shows — and
  those do not survive the document itself being deleted.
- **What batches, and what does not.** `wb_document_get` takes up to 20 `documentIds`, so reading
  a workspace's content costs `ceil(N / 20)` calls rather than N. `wb_facet_set` and
  `wb_version_save` take up to 50 each, with the payload — the facets, the label — SHARED across
  every document named; that is what makes them cheap, and also what they are for. What still
  takes exactly one document is `wb_canvas_snapshot` and the per-document content verbs
  (`wb_canvas_edit`, `wb_body_edit`, `wb_thread_edit`), where each document's payload is its own
  and there is nothing to share. `wb_document_get`'s 20 is lower than the writes' 50 because it
  returns UNTRUNCATED content — for a very large workspace, classify from Step 1's `kind` and
  sample the content rather than reading every document whole.
