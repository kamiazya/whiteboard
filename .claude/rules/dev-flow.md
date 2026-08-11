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

**Docs sync**: a user-visible / API / contract / config change ships with its docs in the same increment (`technical-writer` + `docs-sync` skill; honesty — document the shipped state, never the aspiration). **`./docs/**` is USER docs (Diátaxis); developer docs are OSS-convention root files (README / SECURITY / CONTRIBUTING / CODE_OF_CONDUCT / .github). All project docs are in ENGLISH.** Marketing/release notes are drafts only (`marketing` agent), human ships.

**Code placement and package boundaries** are governed by `.claude/rules/architecture-map.md` (always-on) and `.claude/rules/package-*.md` (path-scoped). Every PR that adds a package ships its path-scoped rule in the same increment.

## Ticketing (no GitHub Issues — all local-private)

Native **Task list** = live board (in-flight / blocked / done; main session owns status). **Whiteboard canvases** = durable private backlog: issues and notes stored as OKF Markdown canvases in the `default` workspace with `issue/1` facets (status/priority/assignees). Create via `wb_canvas_create` + `canvas_import_okf`, query via `wb_canvas_list` + `canvas_export_okf`, resolve via `wb_canvas_delete`. See the `ticketing` skill.

## Skills (load for detail)

`ticketing`, `workflow-authoring`, `zod-schema-discipline`, `test-layer-selection`, `docs-sync`, `whiteboard-mcp-smoke`, `review-gate`, `audit-triage`, `ci-triage`, `dependabot-review`.

## Gates: local + cloud

The integrator's push is guarded on two sides. **Local (pre-push, `lefthook`)**: `pnpm -r typecheck` + `pnpm test --project mcp-node` + `pnpm lint:noconsole` run before the commit leaves the machine (pre-commit only formats staged files, to not slow the dev-loop's worktree commits). **Cloud (post-push)**: GitHub Actions CI (`verify`) + CodeRabbit + AccessLint + WIP + CodeQL — monitor with the `Monitor` tool and triage with the `ci-triage` workflow/skill into Tasks / whiteboard canvases.

**PR merge gate.** `verify` + CodeQL are the authoritative gate. AI review is consulted **when it has actually run**, and its absence does not block a merge (user decision, 2026-08-02): CodeRabbit is on a plan whose per-developer rolling limit this repo's merge pace exhausts, so waiting on it serialises delivery behind a quota rather than behind a real signal. Batching several PRs at once is what burns the quota fastest — when a review matters for a specific change, open that PR alone and let it land. Before merging, still fetch **every bot's** PR review comments and triage each finding; the discipline below applies whenever there *are* comments. Fetch with `gh api repos/<owner>/<repo>/pulls/<n>/comments` + `gh pr view <n> --json reviews,comments`, then **read the comments from ALL bot authors — do not filter to a hardcoded reviewer list.** The surface currently includes **CodeRabbit** (`coderabbitai[bot]`, AI review — Free Plan so not guaranteed) and **`github-advanced-security[bot]`** (CodeQL code-scanning — its findings arrive as ordinary PR review comments on the plain `/pulls/<n>/comments` feed, no `security_events` scope needed, and are same-priority-or-higher security signal). (Gemini Code Assist is **sunset** as of 2026-07-27 — no longer reviews; do not wait on it.) Missing a bot because you scoped the sweep to two named reviewers is exactly the gap that let a CodeQL ReDoS comment slip past this gate — enumerate authors from the feed, don't assume. Triage each finding: (a) verify validity against the actual code (do not trust or dismiss blindly — check the claimed line/behavior; CodeQL security findings on untrusted-input paths get the same red-test-first + fix treatment as any CRITICAL, per the `ci-triage` skill's CodeQL rubric), (b) apply valid findings as commits on the PR branch, (c) for findings judged invalid/stale, record the reason (reply on the PR thread or note in the merge summary to the user). A reviewer skipping a PR (rate limits, plan limits) is acceptable to proceed past — note it when it happens, rather than waiting it out. **Dependabot** (dep-bump PRs + security alerts) has its own `dependabot-triage` workflow + `dependabot-review` skill. Hooks are a net, not the gate — CI is authoritative; `LEFTHOOK=0` / `--no-verify` bypass when justified.
