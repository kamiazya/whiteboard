# ADR-0003: Track .claude AI dev-flow tooling in git with repo-relative workflow scriptPaths

**Status:** Accepted

## Context

This repository uses Claude Code workflows, agents, skills, and scripts under `.claude/` to orchestrate the local AI-assisted dev loop (plan → TDD implement → review → release). Initially `.claude/` was machine-local (gitignored). The question was whether to track it in the shared repository so contributors inherit the full dev-flow tooling.

A deep investigation (6-dimension fan-out, 42 risks identified) confirmed:

- The repo is public OSS with external collaborators; portability fixes are mandatory, not optional.
- The workflow sandbox has no `import.meta` / `__dirname` / `process.cwd` / fs at composition time. The only portable scriptPath mechanism for a shared repo is **repo-root-relative paths** (e.g. `.claude/workflows/review.workflow.mjs`) combined with the discipline of never `cd`-ing away from the repo root while a workflow is running.
- Several absolute home-directory scriptPaths (e.g. `/Users/<user>/...`) existed in `dev-loop.workflow.mjs` and `plan-initiative.workflow.mjs` and had to be made relative before tracking.
- `.claude/settings.json` contains `Authorization: Bearer whiteboard-dev`. This is a **non-secret, well-known loopback-only dev constant** (also present in `ensure-http-dev-daemon.mjs` and test fixtures) that grants nothing off-machine. The original plan was to extract it to the gitignored `settings.local.json`, but Claude Code's settings schema rejects `mcpServers` in `settings.local.json` (validation throws). The token was therefore kept in tracked `settings.json` with a `_comment_auth` field documenting it as non-secret.

## Decision

Track the following under `.claude/` in git:

- `.claude/settings.json` (with Bearer token kept as a documented non-secret dev constant)
- `.claude/agents/*.md`
- `.claude/workflows/*.workflow.mjs` (all scriptPaths converted to repo-root-relative)
- `.claude/rules/*.md`
- `.claude/skills/*/SKILL.md` and referenced files
- `.claude/scripts/new-worktree.mjs`

Keep the following gitignored (local-only, never commit):

- `.claude/settings.local.json` (personal hooks, absolute paths, optional per-contributor token override)
- `.claude/worktrees/` (ephemeral full worktrees with `node_modules`, ~2.6 GB, recreated per dev-loop)
- `.claude/**/*.log` and `.claude/**/*.transcript`

The `CONTRIBUTING.md` "AI dev-flow tooling" section documents: tracked-vs-ignored split, no-cd-while-workflows-run discipline, session-reload-before-new-custom-agent requirement, and first-clone setup steps.

## Consequences

- Contributors cloning the repo get the full dev-flow tooling without manual setup beyond `pnpm install`.
- The `SessionStart` hook (`ensure-http-dev-daemon.mjs`) runs on every clone and auto-starts the MCP HTTP daemon; this is documented in first-clone steps.
- Absolute scriptPaths are banned for shared workflows; this is enforced as a CONTRIBUTING rule (social contract, not technically enforced — a future `cd` inside a workflow Bash call silently re-breaks composition).
- Custom agents added mid-session are not available as `agentType` until the session reloads (documented as gotcha #7 in SKILL.md).

## Alternatives considered

**Keep .claude/ gitignored entirely** — Each developer maintains their own local copy. Rejected: defeats the purpose of a shared, reviewable dev-flow; contributors cannot inherit the orchestration without manual reconstruction.

**Extract Bearer token to settings.local.json** — Cleaner separation of personal vs shared config. Rejected: Claude Code's settings schema does not allow `mcpServers` in `settings.local.json`; the validation rejects it. The token remained in tracked `settings.json` with explicit documentation of its non-secret nature.

**Absolute scriptPaths** — Simpler for the original author's machine. Rejected: breaks for any contributor whose home directory differs from the original author's; incompatible with a public repo.
