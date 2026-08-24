---
name: ticketing
description: Local-private task/ticket management for the whiteboard repo. Issues and notes live in the whiteboard itself (via MCP tools) as OKF Markdown documents. The native Task list tracks in-flight session work. Use when triaging findings, tracking work across dev-loop/review/dogfood-triage/reconcile/plan-initiative, or recording/resolving a follow-up.
---

# Ticketing (local-private)

We deliberately do NOT use GitHub Issues. Two layers + a bridge:

## Two layers

| Layer | What | Lifetime |
|---|---|---|
| **Native Task list** (`TaskCreate`/`TaskList`/`TaskUpdate`/`TaskGet`) | the LIVE board: what is running / blocked / done across workflows this session | session/team-scoped |
| **Whiteboard documents** (MCP tools) | the DURABLE private backlog: issues & notes stored as OKF Markdown documents in the `default` workspace | persists on disk via the daemon |

The **main session (integrator / team-lead) owns Task status transitions**. Subagents may update `metadata` but not flip status to completed (mirrors the team workflow).

## Whiteboard as the issue store

Issues and notes are stored as documents in the whiteboard's `default` workspace. Each is an OKF Markdown document with:

- **type**: `issue` or `note`
- **title**: human-readable title
- **facets**: extension metadata. There is no agreed schema for issue metadata
  right now — see "No structured status" below before inventing one
- **body**: the issue description as markdown

### Creating an issue

One call. `kind` is required, and `markdown` at create time is what saves the
separate `wb_document_set` this flow used to need.

```
wb_document_create → { workspaceId: "default", path: "issues/my-issue",
  kind: "markdown", name: "My Issue",
  markdown: "---\ntype: issue\ntitle: My Issue\n---\n\nDescription here." }
```

Several at once — seeding a triage pass, say — go through one
`wb_workspace_edit` rather than one call per document.

### Reading issues

```
wb_document_list  → { workspaceId: "default" }              # every document, open and closed
wb_document_get   → { workspaceId: "default", documentId }  # read it as OKF markdown
```

### Updating an issue

Re-import with updated OKF markdown (overwrites facets + body):

```
wb_document_set   → { workspaceId: "default", documentId, markdown: "<updated OKF>" }
```

### Updating facets only

```
wb_facet_set → { workspaceId: "default", documentId, facets: { "<namespace>.<name>/v0": { … } }  # key grammar per ADR-0013 }
```

### Resolving

**Resolution is `type: issue` -> `type: note`, not deletion.** Re-import the
document with the type changed, the name prefixed `RESOLVED — `, and a line
in the body saying what resolved it.

**Read it first.** `wb_document_set` replaces core facets, extension facets and
body together — it does not merge — so a resolution that names only `type` and
`title` silently drops `tags`, `facets`, and any root key the document arrived
with (`status`, `sources`, `stale_after`, all preserved verbatim since
[ADR-0016](../../../docs/contributing/adr/0016-okf-trust-family.md)). Under the
old convention that cost nothing, because the document was about to be deleted.
Now it is the whole point.

```
wb_document_get → { workspaceId: "default", documentId }
# take the returned markdown, change ONLY these, keep everything else:
#   type:  issue -> note
#   title: prefixed "RESOLVED — "
#   body:  a line at the top saying what closed it
wb_document_set → { workspaceId: "default", documentId, markdown: <the edited whole> }
```

Both halves earn their place, and neither invents a schema:

- `type` is core OKF and already means this. A resolved issue stopped being a
  work item and became a record, which is what a note is. `type: issue` stays
  the query for "what is open" — the same thing that identified an issue
  before.
- The `RESOLVED — ` name prefix is what a reader sees. `wb_document_list`
  returns `documentId`, `path` and `name` and no frontmatter, so without it
  telling an open issue from a closed one costs one `wb_document_get` per
  document. Someone reached for this prefix by hand before it was written
  down, which is how it got here. If `wb_document_list` ever reports `type`,
  the prefix becomes redundant.

### Deleting

Deletion is for a document that was never worth keeping — a scratch probe, a
duplicate, a mistake. It is **not** how work is closed.

```
wb_document_delete → { workspaceId: "default", documentId }
```

Resolution used to be deletion, and that was carried over from when issues
were markdown files under `tmp/` — where deleting the file was the only move
available. It was never a decision about this store, and it cost real work:
what an issue accumulates is measurements and refuted hypotheses, and deleting
it throws exactly those away while leaving nothing to stop the same issue
being filed and investigated again. Observed: one flake was investigated,
filed, deleted as resolved, and re-filed by another session within minutes,
its analysis redone from scratch.

### No structured status

The `issue/1` facet domain was retired: it was implemented by an earlier pass
without an agreed schema, and a typed companion nobody called made it look
more settled than it was. Nothing has replaced it, and nothing needs to for
open-vs-closed — that is what `type` above carries, using a core OKF field
rather than a domain of our own.

So an issue document carries `type`, a `title`, and a body — and no
machine-readable priority or assignee. There is no evidence either is needed:
one person works this backlog, and the Task list already carries in-flight
state.

Do not invent a replacement domain in passing. Extension facets round-trip
unvalidated through the generic bucket, so anything you write will persist and
quietly become the convention. Agree the schema first.

### The other axis: is the write-up still true?

Open-vs-closed is about the WORK. Whether the document's own account is still
accurate is a separate question, and the two move independently — a closed
issue can hold a standing fact worth reading, and an open one can be built on
reasoning since disproved. Both happened in one session.

That axis is OKF v0.2's `status` (`draft` / `stable` / `deprecated`, absent
meaning `stable`), which this codebase preserves on documents that carry it.
Nothing produces or reads it yet, and it should stay that way until something
does — a signal nobody reads is inventory. Do NOT reach for `deprecated` to
mean "resolved": it says the account no longer holds, which would misreport
every closed issue whose write-up is still exactly right.

## tmp/ workspace buckets

Put temporary artifacts in the right bucket (never the root of `tmp/`):
- `tmp/issues/` — legacy issue source files (migrated to whiteboard documents)
- `tmp/notes/` — legacy design docs (migrated to whiteboard documents)
- `tmp/screenshots/` — UI captures during debug/verify
- `tmp/scripts/` — throwaway helper scripts

For **new** issues and notes, create them directly in the whiteboard via MCP tools.

Delete artifacts from `tmp/` when they're no longer useful.

## Bridge (Task list ⇄ whiteboard documents)

- **Session start**: `TaskList` to see live state; for open issues you intend to work this session, `TaskCreate` a task with `metadata.documentPath = "<path>"`.
- **In flight**: `TaskUpdate` status/owner/blockedBy as work moves.
- **New finding** (from review / dogfood-triage / reconcile): create a document via `wb_document_create` + `wb_document_set`; `TaskCreate` only if you're acting on it now.
- **Resolve**: `wb_document_set` the document to `type: note` FIRST (read it back first — see Resolving), then `TaskUpdate status=completed` once that write has succeeded. The other order leaves the Task list saying done while the issue is still open if the write fails. Do not delete the document.
- Workflows can't call the Task tools or AskUserQuestion; they RETURN findings/openQuestions and the main session records them as tickets/tasks and asks the human.

## When to use which

- Orchestrating several workflow runs / parallel dev-loops right now → **Task list**.
- "Don't lose this for later" → **whiteboard document** (`type: issue`).
- Both, for anything you're actively working from the backlog (create the task, link the document path).
