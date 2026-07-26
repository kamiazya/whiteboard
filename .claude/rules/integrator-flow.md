# Integrator Flow (git / CI mechanics)

Hard-won mechanics for the integrator session. Each rule exists because skipping it caused a real incident. Mechanics that could be automated live in automation instead: a PostToolUse hook syncs local main after every `gh pr merge`, and `new-worktree.mjs` branches from a freshly fetched `origin/main` under the main checkout — if the hook reports "pull skipped", resolve the cause rather than ignoring it.

## pnpm-lock.yaml conflict recipe

When merging main into a feature branch conflicts on `pnpm-lock.yaml`:

```bash
git checkout origin/main -- pnpm-lock.yaml
pnpm install --no-frozen-lockfile   # re-adds this branch's additions
git add pnpm-lock.yaml && git commit --no-edit
pnpm install --frozen-lockfile      # must pass before pushing
```

Never hand-edit the lockfile. If typecheck breaks after a lockfile change with "two copies of the same version" type-identity errors, the branch is usually stale — merge current main first before deeper archaeology.

## Long-running watches

- Use the harness `Monitor` tool for anything that must be watched across turns (CI checks, PR states, deploys). A background subagent's polling loop dies with its turn — a subagent told to "keep polling" will silently stop.
- If an executor agent is needed, pair it with a Monitor: the monitor detects the event, the main session wakes the agent for one action.

## CI flakes

- A known-flake failure gets one `gh run rerun <id> --failed`. The second occurrence of the same flake in CI promotes it to a root-cause fix lane (own worktree + dev-loop); do not keep re-running.
- Timestamp-equality and post-teardown assertions on shared global resources (real home dir, wall clock) are the recurring flake shapes here — reviews should reject new ones.
