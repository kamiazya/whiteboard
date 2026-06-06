---
name: ci-triage
description: Monitor and triage the POST-PUSH automated-review surface for the whiteboard repo — GitHub Actions CI, CodeRabbit, AccessLint, the WIP app, CodeQL, and Dependabot — into Tasks/tmp-issues. Use after the integrator pushes, when CI/PR checks complete or a review bot comments, to decide what is real and file/fix it. Complements the local lefthook pre-push gate (which runs before push); this covers what only the cloud sees.
---

# CI & automated-review triage (whiteboard)

`lefthook` (pre-push) catches local build/test/typecheck breakage before push. This skill covers the layer ONLY the cloud sees after push: CI workflows + the GitHub-App review bots on the PR. The integrator monitors them, separates signal from noise, and files actionable items into the Task list / `tmp/issues` (or fixes quick ones on the spot).

## What runs on this repo (verified surface)

| Source | What it is | How to read it |
|--------|-----------|----------------|
| **`verify`** | GitHub Actions CI (lint:noconsole + tests/typecheck/smoke per `.github/workflows/`) | `gh pr checks <PR>`; logs: `gh run view <run-id> --log-failed` |
| **CodeRabbit** | AI PR review (line comments + summary). **Skips while the PR title contains `WIP`/draft** | `gh pr view <PR> --json reviews,comments`; `gh api repos/{owner}/{repo}/pulls/<PR>/comments` |
| **AccessLint** | accessibility review app | its check + PR review comments |
| **WIP** | blocks merge while the title says WIP | `gh pr checks` shows it pending; remove `WIP`/`(WIP)` from the title to release it + un-skip CodeRabbit |
| **CodeQL** | security code-scanning (may be unconfigured — `code-scanning/alerts` → 404 "no analysis") | `gh api repos/{owner}/{repo}/code-scanning/alerts` (needs `security_events`/admin scope) |
| **Dependabot** | dependency vulns (currently 33 on the default branch) | the Security tab; `gh api .../dependabot/alerts` (scope-gated) |

Note: some security APIs need `gh auth refresh -s security_events` (or admin) — if a fetch 404s on scope, skip that source and note it rather than failing the triage.

## Monitor (live)

Watch the PR's checks until they settle, emitting each terminal result (use the `Monitor` tool):

```bash
prev=""
while true; do
  s=$(gh pr checks <PR> --json name,bucket,link 2>/dev/null || echo '[]')
  cur=$(jq -r '.[] | select(.bucket!="pending") | "\(.name): \(.bucket)"' <<<"$s" | sort)
  comm -13 <(echo "$prev") <(echo "$cur")    # emit only newly-settled checks
  prev=$cur
  [ "$(jq -r '[.[]|select(.bucket=="pending")]|length' <<<"$s")" = "0" ] && break
  sleep 30
done
```

PushNotification when a check flips to `fail` — that changes what the integrator does next.

## Triage (the `ci-triage` workflow)

`Workflow({ scriptPath: '.claude/workflows/ci-triage.workflow.mjs', args: { pr: 56 } })` gathers failed-check logs + CodeRabbit/AccessLint comments, triages each source (real vs noise, severity), adversarially verifies the load-bearing ones, and returns a deduped backlog. Read-only — the integrator files the survivors.

## Triage rubric (signal vs noise)

- **CI `verify` failure** → almost always REAL and blocking. Read `--log-failed`, reproduce locally, fix on the spot (it gates merge). A flaky-isolation failure (see `audit-test-fixture-dedup`) is the one exception — re-run before treating as real.
- **CodeRabbit** → high recall, variable precision. Treat each comment as a CANDIDATE: keep correctness/security/contract points; drop style nits already covered by Biome and "consider"-grade suggestions that don't apply. Verify against the actual code before filing (it hallucinates context).
- **AccessLint** → real a11y findings on UI diffs; keep, file under the touched component.
- **CodeQL** → security; treat HIGH+ as task-track, verify the data-flow is real (not a sanitized path).
- **Dependabot** → see `tmp/issues/dependabot-vulns-default-branch.md`; bump critical/high first.

## Filing (integrator)

Per finding: blocking/CI → fix now; real but not blocking → `TaskCreate` (track=task) or `tmp/issues/<slug>.md` (backlog) per the `ticketing` skill; noise → dismiss (resolve the CodeRabbit thread with a one-line why). Don't refile what's already a Task/issue.

## WIP gotcha

This PR (#56) is titled `…(WIP)`, so CodeRabbit shows **"Review skipped"** and the WIP check blocks merge. To get the full automated review + unblock merge, the integrator removes `WIP`/`(WIP)` from the PR title (or marks it ready) — a deliberate human step, not automatic.
