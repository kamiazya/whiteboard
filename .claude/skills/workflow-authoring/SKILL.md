---
name: workflow-authoring
description: Conventions and hard-won gotchas for authoring/maintaining the whiteboard repo's Dynamic Workflows (.claude/workflows/*.workflow.mjs) — dev-loop, review, dogfood-triage, reconcile. Use when editing or adding a Workflow script, debugging args not arriving, composing workflows, or running parallel dev-loops.
---

# Workflow Authoring (whiteboard)

The repo's Dynamic Workflows live in `.claude/workflows/*.workflow.mjs` and are run via the Workflow tool. Roles: `dev-loop` (one task's inner loop) composes `review` (change-review gate, which has an optional inline dogfood phase); `plan-initiative` (multi-perspective planning) optionally composes `consult-adversarial` (Vet) and `investigate` (ground policy/hygiene/portability questions); `dogfood-triage` (standalone persona dogfooding); `reconcile` (pre-merge intent/conflict reconciliation); `investigate` (read-only, lightweight: fan out one investigator per concern dimension → synthesize a go/no-go with required-before-adopting steps; reusable for any "is it safe to commit/track X" question). The **main session is the single integrator** — it holds human gates (design approval, commit, PR, merge), git, and CI monitoring; workflows automate the rest and return `needsHumanGate`.

## Gotchas (verified)

1. **`args` arrives as a JSON *string*, not an object.** `args.foo` is always `undefined` → silent fallback to defaults. Normalize at the top of every script:
   ```js
   const A = (() => { try { return typeof args === 'string' ? JSON.parse(args) : (args && typeof args === 'object' ? args : {}) } catch { return {} } })()
   ```
   Then read `A.foo`. (A no-arg `args-probe` workflow that `return { typeofArgs: typeof args }` confirms this.)

2. **Nesting is ONE level.** `workflow()` inside a child throws. So `dev-loop → review` is fine, but `review` must NOT call `workflow()` — its dogfood is an **inline phase** (agent + Playwright), not a nested workflow. `reconcile` only detects/judges; the integrator does the actual fold.

3. **Parallel dev = main session fans out, not a parent workflow.** A parent-workflow → dev-loop → review would be 2 levels. Instead the main session launches several `dev-loop` runs concurrently (each its own task), and folds results via `reconcile`.

4. **Parallel dev-loops run in isolated worktrees.** A bare `git worktree` has no `node_modules`, but `node .claude/scripts/new-worktree.mjs <name> [baseRef]` does `git worktree add .claude/worktrees/<name>` + `pnpm install --prefer-offline` (~6s, warm pnpm store) so tests/typecheck run isolated there. **Parallel pattern**: the integrator (main session) creates one ready worktree per independent item, launches a `dev-loop` with `cwd=<that worktree>` (cwd-aware: `git -C <cwd>` + agents edit under it), runs several concurrently, then `reconcile` before folding. The main session stays at repo root (never `cd`s away — see #5). A single-task dev-loop may still run on the main tree (implement stages only its files, never `-A`).

5. **Compose with a REPO-ROOT-RELATIVE `scriptPath` (`.claude/workflows/review.workflow.mjs`) and NEVER `cd` away from repo root while workflows run.** The runtime resolves a relative scriptPath against the *session* cwd at call time. Because the repo mandates that the main session stays at repo root (it passes absolute paths to Bash / uses `git -C`, never `cd`s away), a repo-relative scriptPath always resolves. An absolute `/Users/...` path is **banned for shared workflows** — it breaks for every other contributor and clone location (this repo is public OSS). The workflow sandbox has no `import.meta`/`__dirname`/`process.cwd`/fs, so there is no programmatic path anchor; relative-path-plus-no-cd-discipline is the only portable mechanism. (History: an *unguarded* relative path once broke a 43-min/3M-token run when a Bash `cd` changed cwd mid-run — the fix is the no-cd discipline, not an absolute path.)

6. **`.claude/workflows/` is NOT name-registered.** `Workflow({name:'review'})` fails; launch with `Workflow({scriptPath:'.claude/workflows/review.workflow.mjs'})`. The dir is also gitignored via local `.git/info/exclude` (`git add -f` to share).

7. **Custom agents added mid-session are NOT in the `agentType` registry until a session reload.** Writing `.claude/agents/foo.md` and immediately launching a workflow that does `agent({agentType:'foo'})` throws `agent type 'foo' not found` (the registry is snapshotted at session start) — the workflow still runs but every such `agent()` call fails (verified: `investigate` fanned out 6 dimensions, all failed, only the registered `architect` synth survived). **Default workflow `agentType`s to already-registered agents** (architect, Explore, developer, general-purpose, reviewer-dimension, plan-reviewer, qa-scenario, security-scanner, code-simplifier:code-simplifier, the planning panel, codex:codex-rescue…) and thread an override arg for the tuned custom one (e.g. `investigate` defaults its investigator to `Explore`, overridable via `args.investigatorAgent`). Reload the session before relying on a newly-authored agent as a workflow `agentType`.

## Conventions

- **Specialize phases via `agentType`.** Pass `{agentType:'reviewer-dimension'|'qa-scenario'|'security-scanner'|'code-simplifier:code-simplifier'|'plan-reviewer'|'developer'|...}`. It composes with `schema` (StructuredOutput appended). Default (no agentType) = generic agent + inherited AGENTS.md.
- **Structured output**: pass a JSON-Schema `schema` so the agent returns validated data, not prose.
- **cwd/baseRef**: cwd-aware scripts prepend `git -C <cwd>`; review diffs `${baseRef}..HEAD`. The integrator captures `baseRef` (pre-task HEAD) before launching.
- **Cost**: tune `dimensions`/`qaScenarios`/persona counts down for small increments. A full `review` is ~600k tokens; a full `dev-loop` more.
- **Iterate** by editing the script file and re-invoking `Workflow({scriptPath, resumeFromRunId})` — unchanged `agent()` calls return cached.
- **Syntax-check locally** without running: wrap the body in `async function _wf(){ ...stubs... }` and `new Function(...)`.
