# Development Flow (local, AI-orchestrated)

Always-on map of how work runs in this repo. Day-to-day development goes through local, gitignored AI tooling under `.claude/` (workflows / agents / skills). The **main session is the single integrator**: it owns human gates (AskUserQuestion), git, CI, and status. Workflows automate bursts of work; a persistent Agent Team handles iterative consensus. Detailed how-to lives in **skills** (loaded on demand) — this rule is the index so the flow is never missed.

## Lifecycle

`plan-initiative` (multi-perspective panel + visualize on the local whiteboard) → align (AskUserQuestion / Agent Team on the canvas) → `dev-loop` ×N (one per slice, worktree-isolated when parallel) → `reconcile` (pre-merge intent/conflict check) → integrator folds + **single push**.

Small change? Skip planning and go straight to `dev-loop`. Periodic product check? `dogfood-triage`.

**Parallelism — don't serialize development.** Independent items run as **concurrent dev-loops, each in its own worktree** so none contends on the main working tree. Create a ready worktree with `node .claude/scripts/new-worktree.mjs <name>` (`git worktree add` + `pnpm install`, ~6s), launch a `dev-loop` with `cwd=<worktree>`, run several at once, then `reconcile` and fold in dependency order. The main session orchestrates from repo root and never `cd`s away while workflows run (relative `scriptPath` would break). Assign disjoint write scopes (owned-files / do-not-edit) per parallel item; sequence items that share files.

## Workflows (`.claude/workflows/*.workflow.mjs`)

Launch via `Workflow({scriptPath})` — they are NOT name-registered. `args` arrives as a JSON **string** → `JSON.parse` it (see `workflow-authoring` skill). Composition nesting is one level (dev-loop → review only).

- **dev-loop**: design → PlanReview gate → TDD implement → simplify → review (composed) → triage/fix → (optional) docs sync. Returns `needsHumanGate`.
- **review**: multi-dimension review + adversarial verify + QA (+ optional live dogfood). Composable child of dev-loop.
- **dogfood-triage**: persona browser dogfooding → triage into tmp/issues.
- **reconcile**: textual + intent conflict detection across branches → serial merge plan (judgement only; integrator does the fold).
- **plan-initiative**: expert panel → synthesize sliced plan → gate → visualize on the local whiteboard. Returns `openQuestions` for the main session to ask via AskUserQuestion.
- **consult-adversarial**: answer a hard question/decision, then refute it (skeptic panel) before trusting it — accept iff nothing survives, else focused follow-up, bounded. Feeds plan-initiative / dev-loop; surfaces to human if unresolved.
- **investigate**: lightweight read-only — fan out one investigator per concern dimension → synthesize a go/no-go + required-before-adopting steps. For "is it safe to commit/track X" / portability / hygiene / policy questions. Callable from the **main session** or from **plan-initiative** (`args.investigateQuestions`); NOT from dev-loop/review (already at the 1-level nesting limit). Defaults its investigator to `Explore` (override `args.investigatorAgent`).

## Phase agents (`agentType`)

developer (TDD), plan-reviewer, reviewer-dimension, security-scanner, qa-scenario, code-simplifier:code-simplifier, dogfood-persona, technical-writer (docs sync), repo-hygiene-investigator (read-only repo policy/portability/hygiene investigation — default investigator for `investigate`, but `Explore` is the registered fallback until a session reload picks it up); planning panel: architect, security-architect, ux-designer, project-manager, product-manager, research-analyst (web research: best practices / prior art / standards), whiteboard-designer; release-time: marketing (drafts only, human ships). **Do not use internal-only agents (e.g. `anymind:*`) in this repo's flows. Custom agents added mid-session aren't registered as an `agentType` until reload — see the `workflow-authoring` skill.**

## Gates (Codex second opinion on gate decisions)

- **PlanReview**: `plan-reviewer` + Codex run in parallel — either fail → gate fails; Codex unavailable (null) never blocks.
- **review gate**: dimensions + adversarial verify + Codex lane + QA (+ dogfood).

## Disciplines (non-negotiable)

TDD red-first; Zod single source of truth (`z.infer`, never a parallel hand-written interface); `getLogger` (no `console.*` in server code); behavior-preserving refactors keep existing tests un-weakened; mutation-check schema/regression fixes; immutable updates; single-integrator / single-push. **Temp artifacts go in `tmp/` buckets — screenshots → `tmp/screenshots/` (explicit path), never the repo root or a source dir.**

**Docs sync**: a user-visible / API / contract / config change ships with its docs in the same increment (`technical-writer` + `docs-sync` skill; honesty — document the shipped state, never the aspiration). **`./docs/**` is USER docs (Diátaxis); developer docs are OSS-convention root files (README / SECURITY / CONTRIBUTING / CODE_OF_CONDUCT / .github). All project docs are in ENGLISH.** Marketing/release notes are drafts only (`marketing` agent), human ships.

## Ticketing (no GitHub Issues — all local-private)

Native **Task list** = live board (in-flight / blocked / done; main session owns status). **tmp/issues/*.md** = durable private backlog (frontmatter: id/status/severity/owner/blocked-by/related/created; delete on resolve). `tmp/` and `.claude/` are both gitignored = local to this machine. See the `ticketing` skill.

## Skills (load for detail)

`ticketing`, `workflow-authoring`, `zod-schema-discipline`, `test-layer-selection`, `docs-sync`, `whiteboard-mcp-smoke`.
