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
| **Whiteboard canvases** (MCP tools) | the DURABLE private backlog: issues & notes stored as OKF Markdown canvases in the `default` workspace | persists on disk via the daemon |

The **main session (integrator / team-lead) owns Task status transitions**. Subagents may update `metadata` but not flip status to completed (mirrors the team workflow).

## Whiteboard as the issue store

Issues and notes are stored as canvases in the whiteboard's `default` workspace. Each canvas is an OKF Markdown document with:

- **type**: `issue` or `note`
- **title**: human-readable title
- **facets**: extension metadata. There is no agreed schema for issue metadata
  right now — see "No structured status" below before inventing one
- **body**: the issue description as markdown

### Creating an issue

```
wb_document_create → { workspaceId: "default", segment: "my-issue-slug" }
wb_document_set   → { workspaceId: "default", canvasId: <id>, markdown: "---\ntype: issue\ntitle: My Issue\n---\n\nDescription here." }
```

### Reading issues

```
wb_document_list  → { workspaceId: "default" }           # list all canvases
wb_document_get   → { workspaceId: "default", canvasId }  # export as OKF markdown
```

### Updating an issue

Re-import with updated OKF markdown (overwrites facets + body):

```
wb_document_set   → { workspaceId: "default", canvasId, markdown: "<updated OKF>" }
```

### Updating facets only

```
wb_facet_set → { workspaceId: "default", canvasId, facets: { "<namespace>.<name>/v0": { … } }  # key grammar per ADR-0013 }
```

### Resolving / deleting

```
wb_document_delete → { workspaceId: "default", canvasId }
```

### No structured status

The `issue/1` facet domain was retired: it was implemented by an earlier pass
without an agreed schema, and a typed companion nobody called made it look
more settled than it was. Nothing replaced it yet.

So an issue document carries `type: issue`, a `title`, and a body — and no
machine-readable status, priority or assignee. **Resolution is deletion**,
which is what this skill already did; the retired facet only ever offered an
alternative to that.

Do not invent a replacement domain in passing. Extension facets round-trip
unvalidated through the generic bucket, so anything you write will persist and
quietly become the convention. Agree the schema first.

## tmp/ workspace buckets

Put temporary artifacts in the right bucket (never the root of `tmp/`):
- `tmp/issues/` — legacy issue source files (migrated to whiteboard canvases)
- `tmp/notes/` — legacy design docs (migrated to whiteboard canvases)
- `tmp/screenshots/` — UI captures during debug/verify
- `tmp/scripts/` — throwaway helper scripts

For **new** issues and notes, create them directly in the whiteboard via MCP tools.

Delete artifacts from `tmp/` when they're no longer useful.

## Bridge (Task list ⇄ whiteboard canvases)

- **Session start**: `TaskList` to see live state; for open issues you intend to work this session, `TaskCreate` a task with `metadata.canvasSegment = "<segment>"`.
- **In flight**: `TaskUpdate` status/owner/blockedBy as work moves.
- **New finding** (from review / dogfood-triage / reconcile): create a canvas via `wb_document_create` + `wb_document_set`; `TaskCreate` only if you're acting on it now.
- **Resolve**: `TaskUpdate status=completed`, then `wb_document_delete` the document.
- Workflows can't call the Task tools or AskUserQuestion; they RETURN findings/openQuestions and the main session records them as tickets/tasks and asks the human.

## When to use which

- Orchestrating several workflow runs / parallel dev-loops right now → **Task list**.
- "Don't lose this for later" → **whiteboard document** (`type: issue`).
- Both, for anything you're actively working from the backlog (create the task, link the canvas segment).
