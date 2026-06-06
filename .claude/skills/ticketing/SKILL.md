---
name: ticketing
description: Local-private task/ticket management for the whiteboard repo across workflows and agents, without GitHub Issues. Defines the tmp/ workspace buckets, the tmp/issues frontmatter convention, and the bridge between the native Task list (live board) and tmp/issues (durable backlog). Use when triaging findings, tracking in-flight work across dev-loop/review/dogfood-triage/reconcile/plan-initiative, or recording/resolving a follow-up.
---

# Ticketing (local-private)

Both `tmp/` and `.claude/` are gitignored, so everything here is **local to this machine** — not committed, not on GitHub, not shared. We deliberately do NOT use GitHub Issues. Two layers + a bridge:

## Two layers

| Layer | What | Lifetime |
|---|---|---|
| **Native Task list** (`TaskCreate`/`TaskList`/`TaskUpdate`/`TaskGet`) | the LIVE board: what is running / blocked / done across workflows this session | session/team-scoped |
| **`tmp/issues/` markdown** | the DURABLE private backlog: findings & follow-ups that outlive a session | persists on disk |

The **main session (integrator / team-lead) owns Task status transitions**. Subagents may update `metadata` but not flip status to completed (mirrors the team workflow).

## tmp/ workspace buckets

Put temporary artifacts in the right bucket (never the root of `tmp/`):
- `tmp/issues/` — open findings / follow-ups (one file per ticket; subdirs by area/role allowed)
- `tmp/notes/` — design docs, scratch writeups, investigation summaries
- `tmp/screenshots/` — UI captures during debug/verify
- `tmp/scripts/` — throwaway helper scripts

Delete an artifact when it's no longer useful. **Delete a `tmp/issues` ticket once resolved** — the backlog holds OPEN items only.

## tmp/issues frontmatter convention

Each ticket starts with:

```markdown
---
id: <kebab-or-date-slug>            # stable handle, matches filename
status: open | in-progress          # resolved tickets are deleted, not kept
severity: HIGH | MEDIUM | LOW
owner: <role/agent or unassigned>
blocked-by: [<id>, ...]             # other ticket ids
related: [<file | workflow | run-id>, ...]
created: YYYY-MM-DD                  # absolute date
---

# <title>

## Context / Finding / Root cause / Suggested fix
...
```

Keep the body actionable: what's wrong, where (file:line), and the suggested next step. No process narrative.

## Bridge (Task list ⇄ tmp/issues)

- **Session start**: `TaskList` to see live state; for the open `tmp/issues` you intend to work this session, `TaskCreate` a task with `metadata.ticket = "tmp/issues/<id>.md"`.
- **In flight**: `TaskUpdate` status/owner/blockedBy as work moves. Mirror `blocked-by` from the ticket into `addBlockedBy`.
- **New finding** (from review / dogfood-triage / reconcile): write a `tmp/issues/<id>.md` with frontmatter; `TaskCreate` only if you're acting on it now.
- **Resolve**: `TaskUpdate status=completed`, then **delete** the `tmp/issues/<id>.md` file.
- Workflows can't call the Task tools or AskUserQuestion; they RETURN findings/openQuestions and the main session records them as tickets/tasks and asks the human.

## When to use which
- Orchestrating several workflow runs / parallel dev-loops right now → **Task list**.
- "Don't lose this for later" → **tmp/issues** ticket.
- Both, for anything you're actively working from the backlog (create the task, link the ticket).
