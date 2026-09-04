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
- **dimensions**: defaults to the six below. Pass a subset to focus, or supply `{name, content}` objects to inject externalized criteria (see below). Legacy plain-string dimensions are still supported.
- **auditorAgent**: defaults to `Explore` (read-only, always registered). The tuned `codebase-auditor` agent is NOT registered until a session reload (see the `workflow-authoring` skill's mid-session-agent-registration gotcha) — pass `auditorAgent: 'codebase-auditor'` only after a reload.
- **verifyFloor**: lowest severity that gets an adversarial verify pass (default `HIGH`). Verification kills false positives — the audit favors recall, verify restores precision.

It returns `triaged.items[]` (read-only), plus coverage-honesty fields: `dimensionsAudited` (dimensions that actually produced a result), `failedDimensions` (a dimension's auditor agent returned nothing — a LOW `coverage-gap` advisory finding is also injected into `triaged` so a silent gap can't hide), and `notApplicable` (an auditor explicitly opted out via `notApplicable:true` because the dimension doesn't apply to this scope). Check `failedDimensions` before trusting a clean run. **The workflow cannot create Tasks** — the integrator (main session) files the survivors.

## The six dimensions

`wiring-gaps` (looks-done-isn't) · `architecture` (seams/coupling) · `maintainability` (size/dup/dead-code) · `contract-drift` (hand-written-vs-Zod, casts) · `test-gaps` (untested critical paths, skips) · `dev-experience` (clean-clone friction).

A seventh, `ai-assets` (drift within the `.claude/` asset ecosystem itself —
stale cross-references, frontmatter validity, skill/agent overlap, naming
consistency, coverage gaps), is available as an opt-in `resources/*.md`
dimension (see below). It is not part of the embedded six-dimension default
in `audit-triage.workflow.mjs` — pass it explicitly via the externalized
`{name, content}` mechanism when auditing the tooling itself.

## Externalized criteria (`resources/*.md`)

Each dimension's detailed criteria lives in `.claude/skills/audit-triage/resources/<dimension>.md` (Title-Case `# <Name>` heading + `## Criteria` + numbered checks), not embedded only in `.claude/agents/codebase-auditor.md`. To run with the authoritative externalized criteria:

1. `Glob('.claude/skills/audit-triage/resources/*.md')`.
2. `Read` each file; derive `name` from the **filename** (kebab-case, minus `.md` — e.g. `contract-drift.md` -> `contract-drift`), not the Title-Case `# ` heading. This keeps `name` matching the canonical kebab-case dimension identifiers used everywhere else (the default dimension list, the `FINDING.kind` values, `dimensionsAudited`/`failedDimensions`/`notApplicable`). Use the full file body as `content`.
3. Pass `args.dimensions = [{name, content}, ...]` (a subset is fine — narrow to the dimensions relevant to this run).

**Workflow scripts have no filesystem access** — the workflow cannot glob/read `resources/*.md` itself. The launching session (this skill's caller) must do the glob+read and pass `content` through `args`; that is why the mechanism accepts `{name, content}` objects rather than a directory path.

`.claude/agents/codebase-auditor.md` still carries its own embedded summary of the six dimensions as a legacy fallback (used when a caller passes plain dimension strings, or omits `dimensions` entirely). This is a deliberate duplication, not an oversight: `resources/*.md` is authoritative when `content` is supplied; the agent's embedded text is only the safety-net default.

## Ad-hoc dimensions

The launching session is not limited to the resource pack. For a run scoped
to something the standing dimensions don't cover well (e.g. "audit only the
websocket reconnection logic" or "audit the release-please config"),
synthesize a target-specific `{name, content}` dimension on the fly — same
`# <Name>` + `## Criteria` + numbered-checks shape as a `resources/*.md`
file — and pass it in `args.dimensions` alongside (or instead of) the base
resource dimensions.

After the run, review `triaged.items[]` grouped by dimension: an ad-hoc
dimension that produced real, verified findings (survived `verifyFloor`) is
a candidate worth keeping for future runs. Offer it to the user for
persistence as a new `.claude/skills/audit-triage/resources/<name>.md` file
using the same structure. **Only persist on explicit user approval** —
an ad-hoc dimension that found nothing this run, or that duplicates an
existing resource, should not be added.

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
- `track: "issue"` → a whiteboard document with `type: issue` (`wb_document_create` + `wb_document_set`; see the `ticketing` skill). Durable backlog.
- **Skip dupes** of existing Tasks / tmp-issues (the triage agent flags `relatedTo`, but check the board yourself — it can't see it).
- Quick wins (effort `S`, a few lines) that are safe and in-scope: per the resolve-on-the-spot discipline, just fix them now instead of filing.

## Cadence

Run it **after each fold/merge of a substantial slice**, and/or **weekly**, and **before a milestone/release**. It can be scheduled with `CronCreate` (autonomous loop) or `ScheduleWakeup`, but keep a human in the loop on the *filing* step — auto-creating dozens of tasks unattended is noise. Prefer: scheduled run → integrator reviews `triaged` → files the real ones.

## Discipline

- Read-only: auditors and verifiers never edit.
- Don't double-file: reconcile against the existing Task list + open whiteboard issues (`wb_document_list`, `type: issue`) before creating.
- Trust runtime: if an audit finding disagrees with what the running app/test actually does, the runtime wins — verify before filing.

## Record the run

After folding the survivors, append the run to the tracked ledger so the
`audit-nudge` SessionStart hook stops counting from the last one:

```
node .claude/scripts/record-audit.mjs audit-triage
```

Commit `.claude/audit-log.jsonl` with the fold. The hook nudges every session
once the newest `audit-triage` entry is older than 7 days — that is the
"weekly" cadence made discoverable instead of remembered.
