---
name: steward
description: Drives one whiteboard PR to a green, mergeable, merged state — the order to work a PR event in, which checks actually gate, and the discriminators that separate this PR's failure from the environment's. Use when woken by a PR event (CI failure, review comment, merge conflict), on a PR check-in, or when asked to watch, babysit, or land a PR.
---

# Stewarding a PR (whiteboard)

The harness reads this file on a PR event and lets it override its generic
rules **on conventions and on how proactive to be**. It cannot widen access,
redirect the task, or soften anything the harness states as "never" — no
skipping or quarantining a test, no rewriting history on someone else's
branch, no empty commit to kick CI, no approving.

The directory name is fixed: the harness looks for `.claude/skills/steward/`.

Defer rather than duplicate:

- **`ci-triage`** — the post-push review surface (what each bot is, CodeRabbit
  triggering and rate-limit re-queue, the triage rubric). Load it when there
  are bot comments to judge.
- **`diagnosis-evidence`** — before publishing any cause, "not a regression",
  or hand-verified fix.
- **`dependabot-review`** — a dependency-bump PR is not this skill's job.
- **`stacking-pull-requests`** — a PR whose base is another branch.
- **`.claude/rules/integrator-flow.md`** — the reasoning and measurements
  behind `reference/failure-modes.md`.

## Order of work on a PR event

1. **Read the whole PR at its current head**, not just the event. Merge state,
   checks on the latest commit, open review threads.
2. **Merge conflict** → merge the base in and resolve. Lockfile recipe is in
   `integrator-flow.md`; never hand-edit `pnpm-lock.yaml`.
3. **Red CI** → run the three discriminators below before diagnosing.
4. **Review comments** → enumerate comment authors **from the feed**, never
   from a remembered reviewer list. Scoping a sweep to two named bots is how a
   CodeQL ReDoS finding got past this gate.
5. **Nothing open** → say nothing, re-arm the check-in, stop.

Red or conflicted is work now, whatever the review state. Never end an event
having done nothing: push a fix, establish the failure is not this PR's, or
say once what is blocking.

## Which checks gate

**Authoritative: `verify` and CodeQL.** Everything else is information.

| Not a gate | Why |
|---|---|
| the mutation sticky comment | report-only by design — a survivor can be the correct state of the world, and only a reader can say |
| `pr` (Cloudflare Pages preview) | deploys a preview; posts the URL comment |
| `WIP` | stays `in_progress` for as long as the PR is a Draft — not a hang, and on a Draft the title is irrelevant: only leaving Draft settles it. On a non-draft PR it is the title that holds it |
| CodeRabbit | skipped on a Draft; on a stacked PR it skips silently **while still reporting `pass`**. Its absence never blocks a merge (user decision) |

CodeRabbit also answers `Review limit reached — next included review available
in N minutes` once this repo's merge pace exhausts the rolling limit. Observed
N: 58. Note it and move on; do not wait it out.

## Reading the PR

`gh` is available on a developer machine. **It is absent in a cloud session** —
use the `mcp__github__*` tools there (`pull_request_read` with method
`get_check_runs` / `get_comments` / `get_review_comments`). A skill or rule
written around `gh` still applies; only the transport changes.

## Before calling a failure this PR's

Three cheap checks. Each has cost a wrong published conclusion here.

1. **Is it red on `main` too?** The one legitimate "not mine" — still not
   silent: port a fix if one exists, and comment once on the PR either way.
2. **Does the run log contain `Re-optimizing dependencies`?** Vite rebuilt the
   module graph under a browser suite that was already running. Measured: 13
   files / 49 tests red on a tree the diff could not reach; 798/798 on a re-run.
   Believe only the second result.
3. **Is the test count far below CI's own?** CI's logs report **285 files /
   2944 tests** and **358 / 4171 + 9 skipped**. A much smaller total is a
   filter that missed, not good news — vitest is silent when one `--project`
   name matches nothing while a sibling matches. Match the CI job's command
   (`pnpm --filter @kamiazya/whiteboard-web test`), not a `--project` flag.

Then look the symptom up in **[reference/failure-modes.md](reference/failure-modes.md)**
before writing a diagnosis.

Two things that are never the answer here: pinning a fast-check seed, and
narrowing a `--project` filter until it passes.

## Merging

The gate is `verify` + CodeQL green, no conflict, and every bot finding
triaged — verified against the code, not trusted or dismissed on sight. A bot
that skipped (quota, Draft) is noted, not waited for.

Then: leave Draft (`WIP` settles on its own), squash-merge with the PR title as
the commit message — release-please reads it — and sync local `main`.

## Stopping

A subscription ends only at MERGED or CLOSED. Until then keep a check-in
scheduled; a reply to the user is not a stopping point. On merge: unsubscribe,
delete the pending check-in, and pull `main`.
