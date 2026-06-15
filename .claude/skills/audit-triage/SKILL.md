---
name: audit-triage
description: How to run the periodic standing-codebase-health audit in the whiteboard repo — fan out auditors across health dimensions, adversarially verify, triage into Tasks/tmp-issues. Use when scheduling or running a periodic review (after a fold, weekly, pre-milestone) for unwired/incomplete features, architecture debt, maintainability, contract drift, test gaps, and dev-experience friction. Not for reviewing a single diff (that is the review workflow).
---

# Audit-Triage (whiteboard)

The per-diff `review` workflow only sees a change. **Standing problems** — a feature that builds but isn't wired (the Cloudflare-shell class), a god module, a contract defined twice, a critical path with no test, onboarding that breaks on a clean clone — never show up in a diff. `audit-triage` is the recurring sweep that finds them and turns them into tickets.

## Run it

```
Workflow({ scriptPath: '.claude/workflows/audit-triage.workflow.mjs',
           args: { scope?, dimensions?, cwd?, auditorAgent?, verifyFloor? } })
```

- **scope**: free-text area to focus (e.g. `"apps/web and its migration"`) or omit for the whole repo. Narrow the scope for a faster, deeper pass on a hot area.
- **dimensions**: defaults to the six below; pass a subset to focus.
- **auditorAgent**: defaults to `Explore` (read-only, always registered). The tuned `codebase-auditor` agent is NOT registered until a session reload (workflow-authoring gotcha #7) — pass `auditorAgent: 'codebase-auditor'` only after a reload.
- **verifyFloor**: lowest severity that gets an adversarial verify pass (default `HIGH`). Verification kills false positives — the audit favors recall, verify restores precision.

It returns `triaged.items[]` (read-only). **The workflow cannot create Tasks** — the integrator (main session) files the survivors.

## The six dimensions

`wiring-gaps` (looks-done-isn't) · `architecture` (seams/coupling) · `maintainability` (size/dup/dead-code) · `contract-drift` (hand-written-vs-Zod, casts) · `test-gaps` (untested critical paths, skips) · `dev-experience` (clean-clone friction).

## Severity rubric (precision over recall)

| Severity | Means | Default track |
|----------|-------|---------------|
| CRITICAL | broken/unwired user capability, data-loss/security risk | task |
| HIGH | real bug, missing critical test, architecture decision causing ongoing pain | task |
| MEDIUM | maintainability/clarity debt | issue |
| LOW | minor | issue (or drop) |

A wall of LOWs buries the HIGHs — do not inflate. A false HIGH wastes triage; that's why HIGH+ is adversarially verified before it reaches the backlog.

## Filing the result (integrator)

For each `triaged.items[i]`:
- `track: "task"` → `TaskCreate` on the live board (set `blockedBy`/`relatedTo` from the item). Do soon.
- `track: "issue"` → a `tmp/issues/<slug>.md` with the ticketing frontmatter (see the `ticketing` skill). Durable backlog.
- **Skip dupes** of existing Tasks / tmp-issues (the triage agent flags `relatedTo`, but check the board yourself — it can't see it).
- Quick wins (effort `S`, a few lines) that are safe and in-scope: per the resolve-on-the-spot discipline, just fix them now instead of filing.

## Cadence

Run it **after each fold/merge of a substantial slice**, and/or **weekly**, and **before a milestone/release**. It can be scheduled with `CronCreate` (autonomous loop) or `ScheduleWakeup`, but keep a human in the loop on the *filing* step — auto-creating dozens of tasks unattended is noise. Prefer: scheduled run → integrator reviews `triaged` → files the real ones.

## Discipline

- Read-only: auditors and verifiers never edit.
- Don't double-file: reconcile against the existing Task list + `tmp/issues/` before creating.
- Trust runtime: if an audit finding disagrees with what the running app/test actually does, the runtime wins — verify before filing.
