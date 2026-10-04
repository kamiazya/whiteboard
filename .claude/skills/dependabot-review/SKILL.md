---
name: dependabot-review
description: Triage, review, and merge Dependabot dependency-bump PRs + clear Dependabot security alerts for the whiteboard repo. Security-first, semver x ecosystem classification, verify-CI + `pnpm audit --prod` gate awareness, conflict-cascade-safe batch merging by the single integrator. Adapted for this repo's constraints — NO GitHub Issues (backlog -> Tasks / whiteboard issue documents), release-please conventional commits, npm-published runtime-dep priority. Pairs with the dependabot-triage workflow (which does the read-only analysis fan-out).
---

# dependabot-review (whiteboard)

Triage Dependabot PRs by semver level + ecosystem and safely merge them, and keep the
security-alert backlog clearing. The **`dependabot-triage` workflow** does the read-only
analysis (classify + changelog + repo-impact + CI + adversarial "safe to merge?" + alert
coverage); **this skill is the integrator's execution loop** — judgement + merge mechanics.

## How this repo differs from a generic dependabot flow

Read these before applying the reference playbook — they change several steps:

- **NO GitHub Issues.** This project uses native **Tasks** (live board) + **whiteboard `type: issue` documents**
  (durable private backlog) — see the `ticketing` skill. So **never `gh issue create`** for a
  migration/feature follow-up; file a whiteboard `type: issue` document or a `TaskCreate` instead.
- **Single integrator owns git/CI/merge.** The main session merges; there is no team of
  reviewers approving on GitHub. Merges go to the working branch / `main` per the push model.
- **release-please reads merged commits.** Dependabot already titles PRs `chore(deps): bump …`
  / `chore(deps-dev): …` — keep that on **squash** merge so release-please classifies them as
  no-bump chores. Do not rewrite the title to `fix:`/`feat:`.
- **The CI gate is `ci-gate`** (`.github/workflows/ci.yml`), one required check over every job.
  Its `check` job runs `pnpm audit:prod` (high+, prod deps only) → secretlint → lint → typecheck,
  beside the test jobs and `verify`'s smokes, build and web-app gates. A **prod high+ vuln BLOCKS
  merge** via that audit step. dev-only vulns do not.
- **npm-published artifact.** `@kamiazya/whiteboard-mcp` ships its **runtime** deps. Prioritize
  runtime-scope bumps/alerts (they reach users AND gate `pnpm audit --prod`) over dev-only ones.
- **Local pre-push gate (lefthook)** runs typecheck, lint, the mutation-lane and arch-lint guards
  before push (no test suite); CI is authoritative. For the post-merge verification run, see Step 5.

## Load-bearing runtime deps (extra scrutiny)

These ship in the published package and/or anchor a cross-process contract — read the changelog
even for a minor, and run the relevant smoke after merging. The list itself is `LOAD_BEARING` in
`.claude/workflows/dependabot-triage.workflow.mjs`; `.claude/workflows/lib/dependabot-load-bearing.test.mjs`
fails when it names a package no manifest depends on or drifts from this table.

| Package | Why it is load-bearing | Verify after bump |
|---------|------------------------|-------------------|
| `zod` | schema **single source of truth** (`z.infer`, parse at every boundary) | `pnpm smoke:e2e` + typecheck; a minor can shift inference/parse semantics |
| `loro-crdt` | CRDT persistence/merge core | `pnpm --filter @kamiazya/whiteboard-loro-adapter test` + `pnpm vitest run --project server-core-node` |
| `yaml` | OKF frontmatter parse/serialize in `packages/codec` | `pnpm vitest run --project codec-node` |
| `inversify` | the mcp-server DI container | `pnpm vitest run --project mcp-node packages/mcp-server/src/di` |
| `@modelcontextprotocol/server` / `@modelcontextprotocol/client` / `@modelcontextprotocol/ext-apps` | gate every MCP tool contract and the MCP Apps widget | initialize negotiation + `tools/list` + `pnpm smoke:e2e`; re-check the protocol matrix in `docs/contributing/mcp-debugging.md` and the era tests (`app.test.ts`, `serve-stdio-eras.test.ts`) |
| `hono` / `@hono/node-server` | HTTP routes + daemon transport | route tests + `pnpm mcp:http:dev` reachable |
| `kysely` / `@libsql/client` / `@libsql/kysely-libsql` | persistence query layer | `pnpm vitest run --project mcp-node packages/mcp-server/src/server/store` |
| `jose` / `openid-client` | auth tokens / server-mode OIDC sign-in | `pnpm vitest run --project mcp-node packages/mcp-server/src/server/security` |
| `@resvg/resvg-js` / `opentype.js` | headless export rasterising and text measuring | `pnpm vitest run --project mcp-node packages/mcp-server/src/server/export` |
| `pino` / `nanoid` | logging / ids | nearest tests |

`@types/node` must match `.node-version` (**currently 24**) — if a `@types/node` PR bumps the
major past the runtime, **close it** rather than merge.

## Flow

### Step 1 — Triage (run the workflow)

```
Workflow({ scriptPath: '.claude/workflows/dependabot-triage.workflow.mjs', args: { includeAlerts: true } })
```

Returns `plan.mergeOrder` (Security > patch > minor > major; supersedes resolved first),
`plan.needsMigration` (backlog candidates), and `plan.alertCoverage` (each alert → fixed-by-pr /
needs-manual-bump / transitive / dev-only). Scope to specific PRs with `args:{prs:[58,53]}`.

The alerts API needs `security_events`/admin scope; if it 404s, run
`gh auth refresh -s security_events` or read the Security tab and note alerts as unavailable —
do not block PR triage on it.

### Step 2 — Resolve supersedes & close stale PRs first

Dependabot leaves stale PRs when a newer bump of the same package opens (e.g. an earlier
`hono → 4.12.16` superseded by a later `hono → 4.12.21`). Close the superseded one so it does
not consume a merge/rebase cycle:

```bash
gh pr close <stale-number> --comment "Superseded by #<newer> (bumps <pkg> further)."
```

### Step 3 — Merge loop (conflict-cascade-safe)

Every PR touches `pnpm-lock.yaml`, so **merging one almost always conflicts the rest** — that is
expected. Rebase **only the one PR you will merge next** (rebasing all triggers `O(N²)` CI runs).

Repeat until the plan is drained:

1. **Confirm the next PR's `verify` is green** (not just `mergeable`): read the head commit's check-runs over REST —
   `sha=$(gh api repos/{owner}/{repo}/pulls/<n> --jq .head.sha)`, then
   `gh api --paginate repos/{owner}/{repo}/commits/$sha/check-runs --jq '.check_runs[] | "\(.name) \(.status) \(.conclusion)"'`.
   `mergeStateStatus: BLOCKED` with a passing `verify` is just branch-protection awaiting the
   merge action — fine to merge. A failing `verify` is not.
2. **Merge** (squash, keep the `chore(deps):` title for release-please) over REST, since the
   GraphQL-backed `gh pr merge` answers HTTP 403 in a web session:
   ```bash
   gh api -X PUT repos/{owner}/{repo}/pulls/<n>/merge -f merge_method=squash
   ```
   Do **not** use `--auto` (errors when repo auto-merge is off; only consider it for a pending CI
   after confirming with the human).
3. **Rebase only the next PR** in the plan: `gh api repos/{owner}/{repo}/issues/<next>/comments -f body="@dependabot rebase"`.
   Wait — Dependabot takes a few minutes and **CI re-runs after rebase; pre-rebase CI is void**.
4. Back to 1.

> CodeRabbit/AccessLint do not need to pass to merge a dep bump — `verify` is the gate. (CodeRabbit
> skips Draft/WIP PRs anyway; see the `ci-triage` skill.)

### Step 4 — Majors / breaking bumps → backlog (NOT a GitHub issue)

For `plan.needsMigration` items (adversarial verify found a breaking change reaching our code):
do NOT merge. File a backlog entry per the `ticketing` skill:

- a whiteboard document at `issues/deps-migrate-<pkg>-<from>-to-<to>` with `type: issue` (created via
  `wb_workspace_edit` `document.create`, see the `ticketing` skill) carrying: breaking changes, affected paths, official migration guide
  link, and an action checklist. Reference the Dependabot PR number in the body.
- Leave a pointer on the PR: `gh api repos/{owner}/{repo}/issues/<n>/comments -f body="Migration tracked locally; holding this bump."`
  (Do not close it — Dependabot will keep it rebased until the migration lands.)

A **major is not automatically a migration**: if the only breaking change is a runtime floor we
already meet (e.g. "requires Node ≥ 20") or a GitHub Actions runner bump, and `verify` is green,
**merge it** (mark `merge-with-care` and smoke after).

### Step 5 — Post-merge verification

After draining the merge loop, on the integration branch:

```bash
pnpm install
pnpm -r typecheck
pnpm test   # optional: every project at once; CI runs the matrix
pnpm smoke:e2e
pnpm audit --prod --audit-level=high   # mirrors the CI gate — must be clean to merge
```

If a load-bearing dep moved (zod / loro-crdt / MCP SDK / hono), also run its smoke from the
table above. If tests/audit fail, bisect to the offending bump and either pin it back or fix
the call site; report which bump caused it.

### Step 6 — Clear the alert backlog

From `plan.alertCoverage`:

- **fixed-by-pr** → cleared once that PR merges; re-run `pnpm audit --prod` to confirm.
- **needs-manual-bump** (direct dep, no PR) → bump it yourself (`pnpm up <pkg>@<firstPatched>` or
  edit `package.json` + `pnpm install`), run Step 5, commit `fix(deps): bump <pkg> to <ver> (GHSA-…)`.
  Use `fix(deps)` (not `chore`) when it closes a real vuln so release-please records a patch bump.
- **transitive-no-fix** → add a `pnpm.overrides` pin to the patched version if one exists; if not,
  file a whiteboard `type: issue` document and wait for upstream.
- **dev-only-nonci** → does NOT gate `pnpm audit --prod`; lowest priority. Batch with the next
  weekly Dependabot run rather than churning CI now.

## pnpm split-instance gotcha (React Context)

This is a pnpm monorepo with React in both `apps/web` and `packages/mcp-server`. If a React-family
bump (`react` / `react-dom`) lands and tests start failing with `Cannot read properties of null
(reading 'useContext')` or `No QueryClient set`, the virtual store has **two React versions**
(Provider and Consumer became different instances). Diagnose:

```bash
node -e "const c=require('fs').readFileSync('pnpm-lock.yaml','utf8');console.log([...new Set(c.match(/react@[0-9.]+/g))].sort())"
```

Fix by unifying the version across workspaces (align both `package.json` specs; add a
`pnpm.overrides` pin if a transitive dep pulls a second copy), then `@dependabot rebase` and
re-run CI.

## Notes

- **Always read the changelog** — even patches. "It's a patch" / "the diff is only the lockfile"
  is not a reason to skip. The workflow does this; spot-check load-bearing ones yourself.
- **Squash-merge**, keep the `chore(deps):` title (release-please depends on it).
- **Rate limits**: leave intervals when rebasing/merging many PRs; the alerts API + WebFetch can
  rate-limit on the free tier.
- **GitHub Security alerts ⇄ `pnpm audit --prod` can diverge**: a dev-only path vuln shows in the
  Security tab but not in `pnpm audit --prod`, so it does not gate CI. Track those in a whiteboard `type: issue` document
  rather than churning the lockfile.
- **Catalog-managed groups need a manual bump**: for deps versioned via the pnpm-workspace.yaml
  `catalog:` (vite/vitest family), Dependabot's rebase/recreate cannot regenerate a lockfile
  consistent with the catalog — every attempt fails `check` with `ERR_PNPM_OUTDATED_LOCKFILE`
  and cascades to ~8 red jobs. Do not keep recreating: bump the catalog entries yourself
  (`pnpm up -r <pkgs>` in a fresh worktree), open a `chore(deps):` PR, and close the Dependabot
  PR as superseded.
- **After each merge**: pull main immediately and rebase only the next PR (see
  `.claude/rules/integrator-flow.md` for the full post-merge mechanics).
