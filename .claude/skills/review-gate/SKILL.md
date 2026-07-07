---
name: review-gate
description: How to run the whiteboard repo's per-diff change-review gate — args, return contract, and the externalized-criteria mechanism for review.workflow.mjs. Use when running a standalone review gate (pre-merge, pre-un-draft, ad-hoc) or when authoring/tuning the review workflow that dev-loop composes.
---

# Review Gate (whiteboard)

`review.workflow.mjs` is the generic per-diff change-review gate: parallel
multi-dimension review + adversarial verify + QA smoke, returning one
consolidated report. It is the most-invoked workflow in the repo — every
`dev-loop` composes it as its review phase — but is also runnable standalone
against any git range.

## Run it

```
Workflow({ scriptPath: '.claude/workflows/review.workflow.mjs',
           args: { range?, files?, cwd?, dimensions?, qaScenarios?,
                    dogfood?, appUrl?, dogfoodPersonas?, codex? } })
```

- **range**: a git range understood by `git diff`/`git log`. Default
  `'origin/main...HEAD'`.
- **files**: optional explicit scope (array of paths). When omitted, each
  reviewer agent discovers changed files itself via
  `git diff --name-only <range>`.
- **cwd**: optional worktree path so a composed parent (`dev-loop`) can point
  review at an isolated worktree. When set, agents run git as `git -C <cwd>
  ...` and Read files at that absolute path.
- **dimensions**: defaults to `['correctness', 'contract', 'boundary',
  'test-coverage']` (a 4-dimension subset of the 6 documented in
  `.claude/agents/reviewer-dimension.md`; `dead-code` and `auth` are opt-in
  extras — pass them explicitly when relevant). `security` always runs in
  addition, unconditionally. Each entry is either a legacy plain string
  (criteria stays embedded in `reviewer-dimension.md`) or `{name, content}`
  where `content` is authoritative externalized criteria injected into the
  reviewer prompt (see below). A malformed non-string entry (e.g. missing
  `name`) throws instead of silently propagating `undefined`.
- **qaScenarios**: defaults to `['smoke', 'error-recovery', 'startup']`.
- **dogfood**: optional live persona pass over the touched flow. Default
  `false` — requires a running app (`appUrl`).
- **appUrl**: the running app URL for the dogfood phase.
- **dogfoodPersonas**: number of persona passes when `dogfood` is on.
  Default `1`.
- **codex**: adds a Codex second-opinion review lane. Default `false`. If the
  Codex runtime is unavailable, the lane returns `null` and is reported via
  `codexUnavailable` — it never counts as a failed partition dimension and
  never blocks the gate.

## Return contract

```ts
{
  range: string,
  files: string[] | null,
  summary: {
    rawFindings: number,
    confirmed: number,
    critical: number,
    high: number,
    qaFail: number,
    dogfoodFriction: number,
    failedDimensions: number,
  },
  failedDimensions: string[],   // partition dimensions whose agent returned nothing
  notApplicable: string[],      // dimensions that explicitly opted out (notApplicable:true, no findings)
  codexUnavailable?: boolean,   // present ONLY when args.codex was true
  confirmedFindings: Array<Finding & { dimension: string, verdict: {...} }>,
  qa: Array<{ scenario: string, status: 'pass'|'fail'|'skip', notes?: string }>,
  dogfood: Array<{ persona?: string, goalAchieved: 'yes'|'partial'|'no'|'skip', summary: string, friction: [...] }>,
}
```

`persona` is optional — the workflow's `DOGFOOD_SCHEMA` does not list it in
`required` (only `goalAchieved`, `summary`, `friction` are), so a
`dogfood-persona` agent run can legitimately omit it. Destructure with a
fallback (`run.persona ?? 'unlabeled'`) rather than assuming it is always
present.

Coverage-honesty fields mirror `audit-triage`: check `failedDimensions`
before trusting a clean run — a failed mandatory partition lane (e.g.
`security`, `correctness`) is synthesized into `confirmedFindings` as a HIGH
`mandatory review lane failed: <key>` finding rather than silently degrading
to zero findings, so the gate can never read "clean" just because a lane
never ran. `notApplicable` lists dimensions an agent explicitly opted out of
for this diff (e.g. a docs-only change has nothing for `auth` to review).

## Externalized criteria (`resources/*.md`)

Like `audit-triage`, each review dimension's detailed criteria can live in
`.claude/skills/review-gate/resources/<dimension>.md` (Title-Case `# <Name>`
heading + `## Criteria` + numbered checks) instead of only the embedded
summary in `.claude/agents/reviewer-dimension.md`. To run with the
authoritative externalized criteria:

1. `Glob('.claude/skills/review-gate/resources/*.md')`.
2. `Read` each file; derive `name` from the **filename** (kebab-case, minus
   `.md`), not the Title-Case `# ` heading, so `name` matches the canonical
   dimension identifiers used elsewhere (`reviewer-dimension.md`'s `##
   Dimensions` list, the default `dimensions` array, `failedDimensions`,
   `notApplicable`). Use the full file body as `content`.
3. Pass `args.dimensions = [{name, content}, ...]` — a subset is fine, narrow
   to the dimensions relevant to this run.

**Workflow scripts have no filesystem access** — the workflow cannot
glob/read `resources/*.md` itself. The launching session (this skill's
caller) must do the glob+read and pass `content` through `args`; that is why
the mechanism accepts `{name, content}` objects rather than a directory path.

`.claude/agents/reviewer-dimension.md` still carries its own embedded `##
Dimensions` summary (contract, boundary, dead-code, test-coverage, auth,
correctness) as the legacy fallback — used when a caller passes plain
dimension strings, or omits `dimensions` entirely. This is deliberate
duplication, the same pattern `audit-triage` documents: `resources/*.md` is
authoritative when `content` is supplied; the agent's embedded text is only
the safety-net default.

## Discipline

- One level of nesting only: `review` must NOT call `workflow()` (its
  dogfood phase is an inline agent + Playwright pass, not a nested
  workflow) — see the `workflow-authoring` skill's one-level-nesting gotcha.
- `security` is always-on and failable, exactly like any requested
  dimension — it is not optional and is included in the partition whose
  failure gates the run.
- The optional `codex` lane sits outside the partition entirely: it is a
  second opinion, surfaced only via `codexUnavailable`, and never counted
  as a failed dimension.
