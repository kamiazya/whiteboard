# Development Flow (local, AI-orchestrated)

Always-on map of how work runs in this repo. Day-to-day development goes through local AI tooling under `.claude/` (workflows / agents / skills) — this tooling is tracked in git and shared with every clone; only a few sub-paths (`.claude/settings.local.json`, `.claude/worktrees/`, `.claude/**/*.log`) stay per-machine via `.gitignore`. The **main session is the single integrator**: it owns human gates (AskUserQuestion), git, CI, and status. Workflows automate bursts of work; a persistent Agent Team handles iterative consensus. Detailed how-to lives in **skills** (loaded on demand) — this rule is the index so the flow is never missed.

## Lifecycle

`plan-initiative` (multi-perspective panel + visualize on the local whiteboard) → align (AskUserQuestion / Agent Team on the canvas) → `dev-loop` ×N (one per slice, worktree-isolated when parallel) → `reconcile` (pre-merge intent/conflict check) → integrator folds + **single push**.

Small change? Skip planning and go straight to `dev-loop`. Periodic product check? `dogfood-triage`. Periodic **codebase-health** check (standing problems a diff never shows — unwired/incomplete features, architecture/maintainability debt, contract drift, test gaps, onboarding friction)? `audit-triage` → integrator files survivors into Tasks / whiteboard canvases. Run it after each substantial fold, weekly, or pre-milestone.

**Execution mode is chosen up front — the checkpoints are the invariant, who runs them is not.**

| mode | for | verifying in a running app |
|---|---|---|
| `dev-loop` workflow | scope-disjoint parallel work, non-UI, a spec that will not move mid-flight | **impossible** — the `developer` agent has Read/Edit/Write/Bash/Glob/Grep and no browser |
| main session, inline | UI/interaction work; exploratory work whose spec changes as you learn; anything needing judgement mid-course | native |
| hybrid — **the default for UI** | implement inline, then run `review.workflow.mjs` over the diff | native, plus independent review |

Choose as early as possible, and switch when investigation says otherwise: a dev-loop design that answers `manualVerification` with anything but `none:` stops **before** Implement and returns the approved design plus a recommendation, so the main session resumes from the plan instead of restarting. Passing `dogfood:true` + `appUrl` keeps the run instead.

Inline work is held to the same design checkpoints by `node .claude/scripts/check-design.mjs <design.json>`, which lists the unmet ones individually rather than answering yes/no.

Never drop the review lanes just because implementation moved inline. Adversarial verify and an independent QA agent catch what self-review structurally cannot — reviewing your own work is weakest at exactly the self-skepticism those lanes supply.

**Dependent slices stack; disjoint slices parallelise.** They are opposite shapes, and the choice is the same early decision as the mode above. A change that must land in dependency order — a shared package under an MCP tool under a web surface — is a **stack**: `gh stack` gives each layer its own PR and diff, reviewers work the layers in parallel, and `gh stack merge <pr> --squash` lands everything up to a chosen PR atomically. Stack ORDER is not a judgement call here: `architecture-map.md` fixes the dependency direction, so composition roots are always the top layer. Operating one is the `stacking-pull-requests` skill.

**Build a stack with `gh stack init`, or you do not have one.** Chaining PR base branches by hand LOOKS like a stack and is not: `gh stack merge` answers `is not a stack number or a stacked pull request`, and each squash-merge rewrites the layer below into a commit the upper branch has never seen, so every remaining PR goes `CONFLICTING` in turn and has to be reconciled by hand. Verified twice. If you find yourself with a hand-chained set, merging bottom-up and merging `origin/main` back in between each one works (`--ours` on the overlap, since the upper branch is a superset) — but it is manual reconciliation that `gh stack init` would have avoided.

**A stacked PR is not reviewed by CodeRabbit.** It skips any PR whose base is not the default branch — "Auto reviews are disabled on base/target branches other than the default branch" — while the check still reports `pass`. On a stack there are two kinds of green, and only the bottom PR has had AI review at all. Comment `@coderabbitai review` to force one, or accept it knowingly.

Stack only when each lower layer is worth reviewing on its own. One layer, or layers so coupled that the bottom PR means nothing without the top, is one PR — a stack is machinery, and machinery for a change that does not need it is cost with no reviewer benefit.

**Parallelism — don't serialize development.** Independent items run as **concurrent dev-loops, each in its own worktree** so none contends on the main working tree. Create a ready worktree with `node .claude/scripts/new-worktree.mjs <name>` (`git worktree add` + `pnpm install`, ~6s), launch a `dev-loop` with `cwd=<worktree>`, run several at once, then `reconcile` and fold in dependency order. The main session orchestrates from repo root and never `cd`s away while workflows run (relative `scriptPath` would break).

**The only constraint is write-scope disjointness — lane *count* is not.** Launch as many concurrent dev-loops as you have scope-disjoint work for; do not self-impose a lane cap. The gate per item is: its owned/edited files do not overlap another in-flight lane's (different files in the same dir are fine — git merges per file; a *shared* file means sequence them). Tests-only additions (new `*.test.ts`) are almost always disjoint and safe to fan out widely. Fold/`reconcile` cost is the only real ceiling, and it is cheap relative to idle capacity.

**When you run out of scope-disjoint dev work, run `audit-triage` to fill the idle capacity** — it generates the next wave of concrete, scope-tagged work (file its survivors into Tasks / whiteboard canvases, then fan those out). Idle orchestration time is wasted time; keep either real dev lanes or an audit in flight.

**Scope-disjointness is the *correctness* constraint; API capacity is the *throughput* one.** A dev-loop fans out ~10–30 subagents, so a handful of concurrent lanes can saturate the model API. Watch for strain signals — workflows going red in `/workflows`, the Bash safety classifier reporting "temporarily unavailable", or a subagent result that truncates mid-sentence (terminal API death before it committed). When they appear, **`TaskStop` the lowest-value lanes** (test-only audit lanes are the cheapest to re-run) to drop the concurrent agent count, let the API recover, and resume the throttled items later. Practical steady state on this machine is ~3–4 concurrent dev-loops, not unbounded. A lane killed mid-run may not have committed — re-run it (from a fresh worktree or the same one) and verify the branch tip before folding.

## Workflows (`.claude/workflows/*.workflow.mjs`)

Launch via `Workflow({scriptPath})` — they are NOT name-registered. `args` arrives as a JSON **string** → `JSON.parse` it (see `workflow-authoring` skill). Composition nesting is one level (dev-loop → review only).

- **dev-loop**: design → PlanReview gate → TDD implement → simplify → review (composed) → triage/fix → (optional) docs sync. Returns `needsHumanGate`.
- **review**: multi-dimension review + adversarial verify + QA (+ optional live dogfood). Composable child of dev-loop.
- **dogfood-triage**: persona browser dogfooding → triage into whiteboard canvases (issue type).
- **reconcile**: textual + intent conflict detection across branches → serial merge plan (judgement only; integrator does the fold).
- **plan-initiative**: expert panel → synthesize sliced plan → gate → visualize on the local whiteboard. Returns `openQuestions` for the main session to ask via AskUserQuestion.
- **consult-adversarial**: answer a hard question/decision, then refute it (skeptic panel) before trusting it — accept iff nothing survives, else focused follow-up, bounded. Feeds plan-initiative / dev-loop; surfaces to human if unresolved.
- **investigate**: lightweight read-only — fan out one investigator per concern dimension → synthesize a go/no-go + required-before-adopting steps. For "is it safe to commit/track X" / portability / hygiene / policy questions. Callable from the **main session** or from **plan-initiative** (`args.investigateQuestions`); NOT from dev-loop/review (already at the 1-level nesting limit). Defaults its investigator to `Explore` (override `args.investigatorAgent`).
- **audit-triage**: standing whole-codebase health audit (see the always-on note above) — fills idle capacity and feeds the next wave.
- **ci-triage**: triage the **post-push** automated-review surface of a PR (GitHub Actions CI failures, CodeRabbit, AccessLint, CodeQL) → deduped task/issue backlog. The cloud-side complement to the local `lefthook` pre-push gate. `args:{pr}`. See the `ci-triage` skill (verified check surface + gh commands + the WIP-skips-CodeRabbit gotcha). Watch checks live with the `Monitor` tool. (Dependabot has its own flow below.)
- **pr-feedback**: close the post-push loop on a PR *without the integrator hand-editing it* — enumerate **every** commenting author and non-pass check (discovered from the feeds, never a hardcoded reviewer list), adversarially refute each finding against the real code, fix the survivors as commits on the PR branch, and report a **gate gap** per finding. `args:{pr, cwd, branch?}`. Nothing is pushed: the integrator pushes, re-checks, and owns the merge. Use `ci-triage` instead when you want a backlog and explicitly NOT commits. **The waiting cannot move here** — a workflow dies with its turn, so launch this from the main session once a `Monitor` says the feedback exists (see integrator-flow.md).
  - Its `gateGaps` are the self-reinforcement loop: a post-push finding is evidence something upstream missed it, so each one is abstracted to a recurring **class** and assigned the strongest rung that would actually catch it — `executable` (lint/test/arch-lint) > `pre-push` > `review-criteria` (`review-gate/resources/*.md`) > `prose-rule` > `none`. `none` is a real answer: naming and product-judgement findings need a fresh reader, and a rule nobody can act on mechanically dilutes the ones that matter. The integrator decides which proposals land.
- **dependabot-triage**: triage open Dependabot dependency-bump PRs + security alerts into a merge-ordered plan — per PR classify (semver × ecosystem) + changelog + repo-impact grep + `verify` CI + supersede detection, adversarially verify "safe to merge?" for load-bearing/major bumps, and map each alert to the PR that fixes it. Read-only; `args:{prs?, includeAlerts?}`. The integrator executes merges per the `dependabot-review` skill (conflict-cascade-safe, NO GitHub issues — backlog → Tasks / whiteboard canvases, release-please `chore(deps):` titles, published-runtime-dep priority, `pnpm audit --prod` gate).

## Phase agents (`agentType`)

developer (TDD), plan-reviewer, reviewer-dimension, security-scanner, qa-scenario, simplifier (repo-owned; preloads the `ponytail` ladder — the plugin `code-simplifier` carries another project's coding standards in its own prompt, so it is deliberately NOT used here), dogfood-persona, technical-writer (docs sync), repo-hygiene-investigator (read-only repo policy/portability/hygiene investigation — default investigator for `investigate`, but `Explore` is the registered fallback until a session reload picks it up); planning panel: architect, security-architect, ux-designer, project-manager, product-manager, research-analyst (web research: best practices / prior art / standards), whiteboard-designer; release-time: marketing (drafts only, human ships). **Do not use internal-only agents (e.g. `anymind:*`) in this repo's flows. Custom agents added mid-session aren't registered as an `agentType` until reload — see the `workflow-authoring` skill.**

## Gates (Codex second opinion on gate decisions)

- **PlanReview**: `plan-reviewer` + Codex run in parallel — either fail → gate fails; Codex unavailable (null) never blocks.
- **review gate**: dimensions + adversarial verify + Codex lane + QA (+ dogfood).
- **Codex companion timeouts are systemic in this environment** (exit 143 / no output). A timeout is "unavailable", NOT a fail — it must never block a gate. When the Codex lane repeatedly stalls a gate, re-run the dev-loop with `codex:false` rather than letting the timeout read as a rejection.

## Disciplines (non-negotiable)

TDD red-first; Zod single source of truth (`z.infer`, never a parallel hand-written interface); `getLogger` (no `console.*` in server code); behavior-preserving refactors keep existing tests un-weakened; mutation-check schema/regression fixes; immutable updates; single-integrator / single-push. **Temp artifacts go in `tmp/` buckets — screenshots → `tmp/screenshots/` (explicit path), never the repo root or a source dir.**

**Reach is designed, not discovered in review.** Beside `scope` (what you intend to edit), dev-loop's `DESIGN_SCHEMA` requires two answers `scope` cannot give, both judged by PlanReview and re-asked of the diff by the `reachability` review dimension:

- **`blastRadius`** — who else inside the codebase this edit reaches, each caller flagged for whether a test would fail if it broke. `typecheck` already catches *signature* breaks; this is for the caller that still compiles, changed behavior, and has nothing watching it. Use an impact-graph MCP tool (`get_impact_radius_tool`) when connected, else grep. Sentinels: `none:` (leaf change), `unavailable:` (no such tool on this machine — accepted without argument; nobody is gated on optional local tooling).
- **`userReach`** — whether it reaches a USER at all: the registration, route, rendering parent, or flag-read that this increment adds. Built-but-unwired passes every other gate, because the tests pass *precisely by calling the new code directly*. A foundation-only slice is fine; a silently foundation-only one is the defect. Sentinel: `foundation: <reason> — wired by <named follow-up>`, rejected if the follow-up is too vague to file.

`codebase-auditor`'s `wiring-gaps` dimension stays the periodic sweep for whatever still slipped through.

**Simplicity already has two executable rungs — reach for them before writing a prose rule.** `tools/arch-lint`'s allowed-third-party-dependency check fails the build on a dependency added outside a package's allowlist, and `pnpm knip` fails on the unused export a deleted feature left behind. Those are the "don't add a dependency" and "delete it" rungs made mechanical. What the `simplifier` agent and its `ponytail` ladder add on top is only the judgement-shaped rungs (does this need to exist, is this one line) — inherently prose, and the weakest rung by design.

**Measure before you change what you cannot see in the diff.** A heuristic, a cost model, a search or an optimisation is correct-looking code whose worth is entirely in numbers nobody has taken — so the INSTRUMENT lands first, in its own commit, and the change is judged by it. Two exist: `edge-routing-quality.test.ts` (quality: a corpus plus aggregate counts pinned EXACTLY, so an improvement is as loud as a regression, with debt metrics separated from price metrics) and `pnpm bench` (performance: `vitest bench`, compared across INTERLEAVED paired runs because machine drift between separate runs exceeds the effect). For a behaviour-preserving optimisation the scoreboard NOT moving is the proof. This is not ceremony: the instruments rejected three changes that were obviously right on argument — per-blocker detours, a placement cache, and an excess-length penalty tier — and one cheap reachability probe (67 of 68 remaining defects had a clean path available) retired a planned task and redirected the work. They also **rescued** one: an aligned re-score was rejected in its first two shapes on cost (13x, then 4.5x layout time) and shipped in a third that reused machinery already in the file, at 2x — the measurement did not veto the idea, it priced each shape until one was worth paying for. Load the `measured-change` skill. When a change buys one metric with another, `PENALTY_RULES`' declared tier order decides it; when the currencies are genuinely different, that is a human decision worth interrupting for.

**The same scepticism applies one step earlier, to a DIAGNOSIS.** A failure message, a "not a
regression", a mutation check, a hand-verified fix — each arrives looking like evidence while
saying nothing about what was actually exercised. In one session that produced three published
wrong conclusions: a cause read off an assertion string without checking which of two identical
assertions failed; a regression denied by a property of the diff instead of an A/B of the
behaviour; and a mutation check whose restore had already run, so eleven "mutated" runs used the
original file. Each was one printed line away from being caught. Load the `diagnosis-evidence` skill before
reporting ANY diagnostic or verification conclusion — a cause, a "not a regression", a mutation
result, or a fix you are calling verified by hand.

**Visual evidence for a change that moves pixels** is a repeatable procedure, not a screenshot of whatever was on screen: render the SAME canvas through the real pipeline before and after, side by side, chosen by the metric the change targets rather than by eye. Load the `visual-evidence` skill — its traps (a no-op `git stash` producing identical panels, unfilled rects rendering black) have each produced a misleading figure at least once.

**Docs sync**: a user-visible / API / contract / config change ships with its docs in the same increment (`technical-writer` + `docs-sync` skill; honesty — document the shipped state, never the aspiration). **`./docs/**` is USER docs (Diátaxis); developer docs are OSS-convention root files (README / SECURITY / CONTRIBUTING / CODE_OF_CONDUCT / .github). All project docs are in ENGLISH.** Marketing/release notes are drafts only (`marketing` agent), human ships.

**Code placement and package boundaries** are governed by `.claude/rules/architecture-map.md` (always-on) and `.claude/rules/package-*.md` (path-scoped). Every PR that adds a package ships its path-scoped rule in the same increment.

## Ticketing (no GitHub Issues — all local-private)

Native **Task list** = live board (in-flight / blocked / done; main session owns status). **Whiteboard documents** = durable private backlog: issues and notes stored as OKF Markdown documents in the `default` workspace, carrying `type: issue`, a title and a body. Create via `wb_document_create` + `wb_document_set`, query via `wb_document_list` + `wb_document_get`, resolve by `wb_document_delete` — deletion IS resolution. The `issue/1` facet domain was retired (implemented without an agreed schema); until a replacement is agreed there is no machine-readable status, priority or assignee, and inventing one in passing makes it the convention by accident. See the `ticketing` skill.

## Skills (load for detail)

`ticketing`, `workflow-authoring`, `zod-schema-discipline`, `test-layer-selection`, `measured-change`, `diagnosis-evidence`, `visual-evidence`, `docs-sync`, `whiteboard-mcp-smoke`, `review-gate`, `audit-triage`, `ci-triage`, `dependabot-review`, `stacking-pull-requests`.

## Gates: local + cloud

**`apps/web`'s jsdom suite is NOT a root vitest project — run it the way CI does.** CI's `test-jsdom` job runs `pnpm --filter @kamiazya/whiteboard-web test` (which is `vitest run && vitest run --config vitest.node.config.ts`, ~2100 tests). There is no `web-jsdom` project at the root, and **a filter naming a project that does not exist is silent as long as some other `--project` in the same command matches** — `--project web-jsdom --project web-browser` runs only the browser project, reports its ~540 tests, and exits 0. That reads exactly like both suites passing. It let a real regression reach CI twice in one session before anyone noticed the count was too small. Match the local command to the CI job, and treat a test count far below CI's as evidence the filter missed, not as good news.

The integrator's push is guarded on two sides. **Local (pre-push, `lefthook`)**: `pnpm -r typecheck` + `pnpm test --project mcp-node` + `pnpm lint:noconsole` run before the commit leaves the machine (pre-commit only formats staged files, to not slow the dev-loop's worktree commits). **Cloud (post-push)**: GitHub Actions CI (`verify`) + CodeRabbit + AccessLint + WIP + CodeQL — monitor with the `Monitor` tool and triage with the `ci-triage` workflow/skill into Tasks / whiteboard canvases.

**A green PR check does not say the MERGE is green.** `on: pull_request` builds
a merge commit, so CI already tests a branch against main — but only as main
stood when the PR last moved, and nothing re-runs it when main advances.
Measured: #881's head was pushed at 11:37Z, #886 merged at 13:07Z, and #881
stayed green the whole time against a base that no longer existed. Merging it
broke `main` outright — three files importing a module #886 had deleted — and
`MERGEABLE`, a zero-conflict `git merge-tree`, and 19/19 green all called it
safe. None of them was answering the question: a branch that merely IMPORTS
what the trunk deleted has nothing to conflict with. The same shape appeared
four times in one stack, twice more as a clean auto-merge that duplicated a
registration block and silently dropped a signal.

"Require branches to be up to date" is the obvious fix and is deliberately NOT
used (`strict: false`, user decision 2026-08-19): with several dev-loops in
flight it makes every merge invalidate every other PR, which is the parallelism
this whole flow is built on. The answer is a **merge queue** — it tests the
speculative merge (main + anything queued ahead + this PR) at merge time,
batched, so development stays parallel and only the final verification is
ordered. `gh stack merge` composes with it: a stack is added to the queue.

Its one hard prerequisite: **every required check must also run on
`merge_group`**, or the queue waits forever for a check that cannot fire.
`ci.yml` and `pr-title.yml` both declare that trigger; `pr-title` short-circuits
there, because a merge group has no PR title to validate. Adding a required
check means adding the trigger with it.

Until the queue is enabled, the manual stand-in is to typecheck the MERGE
RESULT rather than either side — and for a stacked set, to merge the reconciled
PARENT into each child rather than main separately, which keeps one
reconciliation instead of one per layer:

```bash
git worktree add -q --detach /tmp/premerge origin/<branch>
cd /tmp/premerge && git merge --no-edit origin/main && pnpm -r typecheck
```

**PR merge gate.** `verify` + CodeQL are the authoritative gate. AI review is consulted **when it has actually run**, and its absence does not block a merge (user decision, 2026-08-02): CodeRabbit is on a plan whose per-developer rolling limit this repo's merge pace exhausts, so waiting on it serialises delivery behind a quota rather than behind a real signal. Batching several PRs at once is what burns the quota fastest — when a review matters for a specific change, open that PR alone and let it land. Before merging, still fetch **every bot's** PR review comments and triage each finding; the discipline below applies whenever there *are* comments. Fetch with `gh api repos/<owner>/<repo>/pulls/<n>/comments` + `gh pr view <n> --json reviews,comments`, then **read the comments from ALL bot authors — do not filter to a hardcoded reviewer list.** The surface currently includes **CodeRabbit** (`coderabbitai[bot]`, AI review — Free Plan so not guaranteed) and **`github-advanced-security[bot]`** (CodeQL code-scanning — its findings arrive as ordinary PR review comments on the plain `/pulls/<n>/comments` feed, no `security_events` scope needed, and are same-priority-or-higher security signal). (Gemini Code Assist is **sunset** as of 2026-07-27 — no longer reviews; do not wait on it.) Missing a bot because you scoped the sweep to two named reviewers is exactly the gap that let a CodeQL ReDoS comment slip past this gate — enumerate authors from the feed, don't assume. Triage each finding: (a) verify validity against the actual code (do not trust or dismiss blindly — check the claimed line/behavior; CodeQL security findings on untrusted-input paths get the same red-test-first + fix treatment as any CRITICAL, per the `ci-triage` skill's CodeQL rubric), (b) apply valid findings as commits on the PR branch, (c) for findings judged invalid/stale, record the reason (reply on the PR thread or note in the merge summary to the user). A reviewer skipping a PR (rate limits, plan limits) is acceptable to proceed past — note it when it happens, rather than waiting it out. **Dependabot** (dep-bump PRs + security alerts) has its own `dependabot-triage` workflow + `dependabot-review` skill. Hooks are a net, not the gate — CI is authoritative; `LEFTHOOK=0` / `--no-verify` bypass when justified.
