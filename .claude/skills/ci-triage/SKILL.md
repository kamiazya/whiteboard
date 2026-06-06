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

**Caveat (Draft PRs): the `WIP` check stays `pending` forever while the PR is a Draft** — the WIP app flags Drafts as work-in-progress regardless of the title (removing `(WIP)` from the title is NOT enough; only `gh pr ready <PR>` settles it). `AccessLint` can also linger on Drafts. So a "wait until ALL checks settle" loop never exits on a Draft. **Watch the gating check (`verify`) specifically instead:**
```bash
while true; do
  b=$(gh pr checks <PR> --json name,bucket --jq '.[]|select(.name=="verify")|.bucket' 2>/dev/null)
  [ -n "$b" ] && [ "$b" != "pending" ] && { echo "verify: $b"; break; }
  sleep 60
done
```

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

## CodeRabbit: on-demand trigger + rate-limit re-queue

CodeRabbit does **not** auto-review a **Draft** PR or a PR whose title contains `WIP`/`(WIP)` (it posts "Review skipped"). Two consequences:

- **Monitoring**: the `WIP` GitHub-App check stays *pending forever* while the title says WIP, so a "wait until all checks settle" monitor never exits. Prefer a **Draft PR** for merge-blocking (Draft blocks merge natively) and keep the title WIP-free, so every check settles cleanly.
- **Triggering CodeRabbit on a Draft**: it must be invoked explicitly with a PR comment:
  ```bash
  gh pr comment <PR> --body "@coderabbitai review"        # review the latest changes
  # other commands: "@coderabbitai full review" (re-review everything),
  #   "@coderabbitai pause" / "resume", "@coderabbitai resolve" (resolve its threads),
  #   "@coderabbitai configuration"
  ```

**`@coderabbitai review` is INCREMENTAL** — it does not re-review commits CodeRabbit already reviewed, so on an already-reviewed PR it just replies "✅ Review finished" with no new findings (verified on #56). For a real pass over accumulated work, use **`@coderabbitai full review`**. (Plain `review` is also stated to apply "only when automatic reviews are paused".)

**Strategic timing (free OSS tier = strict rate limits).** Do NOT trigger on every commit. Trigger at meaningful points: a milestone batch landed + green, just before requesting human review, or after a large fold. One review per accumulated batch, not per push.

**Rate-limit → re-queue at the stated recovery time.** When rate-limited, CodeRabbit replies with a comment saying when it will reset (e.g. "rate limit … try again in N minutes" / a timestamp). Flow:
1. Trigger `@coderabbitai review`.
2. Watch for CodeRabbit's response (the `Monitor` tool polling `gh api repos/{o}/{r}/issues/<PR>/comments` for the latest `coderabbitai[bot]` comment).
3. If the response is a **rate-limit** message, parse the reset time and `ScheduleWakeup({ delaySeconds: <until reset + small buffer> })` — on wake, re-post `@coderabbitai review`. Loop until it actually reviews (cap the retries).
4. If it **starts reviewing**, let it finish, then triage its comments via this skill / the `ci-triage` workflow.

Bypass note: removing a PR from Draft (`gh pr ready <PR>`) is a deliberate human step (it signals "ready for human review/merge") — don't auto-undraft.
