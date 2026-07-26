# Development Flow (local, AI-orchestrated)

Always-on map of how work runs in this repo. Day-to-day development goes through local AI tooling under `.claude/` (workflows / agents / skills) — this tooling is tracked in git and shared with every clone; only a few sub-paths (`.claude/settings.local.json`, `.claude/worktrees/`, `.claude/**/*.log`) stay per-machine via `.gitignore`. The **main session is the single integrator**: it owns human gates (AskUserQuestion), git, CI, and status. Workflows automate bursts of work; a persistent Agent Team handles iterative consensus. Detailed how-to lives in **skills** (loaded on demand) — this rule is the index so the flow is never missed.

## Lifecycle

`plan-initiative` (multi-perspective panel + visualize on the local whiteboard) → align (AskUserQuestion / Agent Team on the canvas) → `dev-loop` ×N (one per slice, worktree-isolated when parallel) → `reconcile` (pre-merge intent/conflict check) → integrator folds + **single push**.

Small change? Skip planning and go straight to `dev-loop`. Periodic product check? `dogfood-triage`. Periodic **codebase-health** check (standing problems a diff never shows — unwired/incomplete features, architecture/maintainability debt, contract drift, test gaps, onboarding friction)? `audit-triage` → integrator files survivors into Tasks / tmp-issues. Run it after each substantial fold, weekly, or pre-milestone.

**Parallelism — don't serialize development.** Independent items run as **concurrent dev-loops, each in its own worktree** so none contends on the main working tree. Create a ready worktree with `node .claude/scripts/new-worktree.mjs <name>` (`git worktree add` + `pnpm install`, ~6s), launch a `dev-loop` with `cwd=<worktree>`, run several at once, then `reconcile` and fold in dependency order. The main session orchestrates from repo root and never `cd`s away while workflows run (relative `scriptPath` would break).

**The only constraint is write-scope disjointness — lane *count* is not.** Launch as many concurrent dev-loops as you have scope-disjoint work for; do not self-impose a lane cap. The gate per item is: its owned/edited files do not overlap another in-flight lane's (different files in the same dir are fine — git merges per file; a *shared* file means sequence them). Tests-only additions (new `*.test.ts`) are almost always disjoint and safe to fan out widely. Fold/`reconcile` cost is the only real ceiling, and it is cheap relative to idle capacity.

**When you run out of scope-disjoint dev work, run `audit-triage` to fill the idle capacity** — it generates the next wave of concrete, scope-tagged work (file its survivors into Tasks/tmp-issues, then fan those out). Idle orchestration time is wasted time; keep either real dev lanes or an audit in flight.

**Scope-disjointness is the *correctness* constraint; API capacity is the *throughput* one.** A dev-loop fans out ~10–30 subagents, so a handful of concurrent lanes can saturate the model API. Watch for strain signals — workflows going red in `/workflows`, the Bash safety classifier reporting "temporarily unavailable", or a subagent result that truncates mid-sentence (terminal API death before it committed). When they appear, **`TaskStop` the lowest-value lanes** (test-only audit lanes are the cheapest to re-run) to drop the concurrent agent count, let the API recover, and resume the throttled items later. Practical steady state on this machine is ~3–4 concurrent dev-loops, not unbounded. A lane killed mid-run may not have committed — re-run it (from a fresh worktree or the same one) and verify the branch tip before folding.

## Workflows (`.claude/workflows/*.workflow.mjs`)

Launch via `Workflow({scriptPath})` — they are NOT name-registered. `args` arrives as a JSON **string** → `JSON.parse` it (see `workflow-authoring` skill). Composition nesting is one level (dev-loop → review only).

- **dev-loop**: design → PlanReview gate → TDD implement → simplify → review (composed) → triage/fix → (optional) docs sync. Returns `needsHumanGate`.
- **review**: multi-dimension review + adversarial verify + QA (+ optional live dogfood). Composable child of dev-loop.
- **dogfood-triage**: persona browser dogfooding → triage into tmp/issues.
- **reconcile**: textual + intent conflict detection across branches → serial merge plan (judgement only; integrator does the fold).
- **plan-initiative**: expert panel → synthesize sliced plan → gate → visualize on the local whiteboard. Returns `openQuestions` for the main session to ask via AskUserQuestion.
- **consult-adversarial**: answer a hard question/decision, then refute it (skeptic panel) before trusting it — accept iff nothing survives, else focused follow-up, bounded. Feeds plan-initiative / dev-loop; surfaces to human if unresolved.
- **investigate**: lightweight read-only — fan out one investigator per concern dimension → synthesize a go/no-go + required-before-adopting steps. For "is it safe to commit/track X" / portability / hygiene / policy questions. Callable from the **main session** or from **plan-initiative** (`args.investigateQuestions`); NOT from dev-loop/review (already at the 1-level nesting limit). Defaults its investigator to `Explore` (override `args.investigatorAgent`).
- **audit-triage**: standing whole-codebase health audit (see the always-on note above) — fills idle capacity and feeds the next wave.
- **ci-triage**: triage the **post-push** automated-review surface of a PR (GitHub Actions CI failures, CodeRabbit, AccessLint, CodeQL) → deduped task/issue backlog. The cloud-side complement to the local `lefthook` pre-push gate. `args:{pr}`. See the `ci-triage` skill (verified check surface + gh commands + the WIP-skips-CodeRabbit gotcha). Watch checks live with the `Monitor` tool. (Dependabot has its own flow below.)
- **dependabot-triage**: triage open Dependabot dependency-bump PRs + security alerts into a merge-ordered plan — per PR classify (semver × ecosystem) + changelog + repo-impact grep + `verify` CI + supersede detection, adversarially verify "safe to merge?" for load-bearing/major bumps, and map each alert to the PR that fixes it. Read-only; `args:{prs?, includeAlerts?}`. The integrator executes merges per the `dependabot-review` skill (conflict-cascade-safe, NO GitHub issues — backlog → Tasks/tmp-issues, release-please `chore(deps):` titles, published-runtime-dep priority, `pnpm audit --prod` gate).

## Phase agents (`agentType`)

developer (TDD), plan-reviewer, reviewer-dimension, security-scanner, qa-scenario, code-simplifier:code-simplifier, dogfood-persona, technical-writer (docs sync), repo-hygiene-investigator (read-only repo policy/portability/hygiene investigation — default investigator for `investigate`, but `Explore` is the registered fallback until a session reload picks it up); planning panel: architect, security-architect, ux-designer, project-manager, product-manager, research-analyst (web research: best practices / prior art / standards), whiteboard-designer; release-time: marketing (drafts only, human ships). **Do not use internal-only agents (e.g. `anymind:*`) in this repo's flows. Custom agents added mid-session aren't registered as an `agentType` until reload — see the `workflow-authoring` skill.**

## Gates (Codex second opinion on gate decisions)

- **PlanReview**: `plan-reviewer` + Codex run in parallel — either fail → gate fails; Codex unavailable (null) never blocks.
- **review gate**: dimensions + adversarial verify + Codex lane + QA (+ dogfood).

## Disciplines (non-negotiable)

TDD red-first; Zod single source of truth (`z.infer`, never a parallel hand-written interface); `getLogger` (no `console.*` in server code); behavior-preserving refactors keep existing tests un-weakened; mutation-check schema/regression fixes; immutable updates; single-integrator / single-push. **Temp artifacts go in `tmp/` buckets — screenshots → `tmp/screenshots/` (explicit path), never the repo root or a source dir.**

**Docs sync**: a user-visible / API / contract / config change ships with its docs in the same increment (`technical-writer` + `docs-sync` skill; honesty — document the shipped state, never the aspiration). **`./docs/**` is USER docs (Diátaxis); developer docs are OSS-convention root files (README / SECURITY / CONTRIBUTING / CODE_OF_CONDUCT / .github). All project docs are in ENGLISH.** Marketing/release notes are drafts only (`marketing` agent), human ships.

**Code placement and package boundaries** are governed by `.claude/rules/architecture-map.md` (always-on) and `.claude/rules/package-*.md` (path-scoped). Every PR that adds a package ships its path-scoped rule in the same increment.

## Ticketing (no GitHub Issues — all local-private)

Native **Task list** = live board (in-flight / blocked / done; main session owns status). **tmp/issues/*.md** = durable private backlog (frontmatter: id/status/severity/owner/blocked-by/related/created; delete on resolve). `tmp/` is gitignored = local to this machine; `.claude/` shared tooling (workflows, agents, skills, rules, scripts, settings.json) is tracked in git, so `tmp/issues` is the private-backlog half of the split, not `.claude/` as a whole. See the `ticketing` skill.

## Skills (load for detail)

`ticketing`, `workflow-authoring`, `zod-schema-discipline`, `test-layer-selection`, `docs-sync`, `whiteboard-mcp-smoke`, `review-gate`, `audit-triage`, `ci-triage`, `dependabot-review`.

## Gates: local + cloud

The integrator's push is guarded on two sides. **Local (pre-push, `lefthook`)**: `pnpm -r typecheck` + `pnpm test --project mcp-node` + `pnpm lint:noconsole` run before the commit leaves the machine (pre-commit only formats staged files, to not slow the dev-loop's worktree commits). **Cloud (post-push)**: GitHub Actions CI (`verify`) + CodeRabbit + AccessLint + WIP + CodeQL — monitor with the `Monitor` tool and triage with the `ci-triage` workflow/skill into Tasks/tmp-issues. **Dependabot** (dep-bump PRs + security alerts) has its own `dependabot-triage` workflow + `dependabot-review` skill. Hooks are a net, not the gate — CI is authoritative; `LEFTHOOK=0` / `--no-verify` bypass when justified.
