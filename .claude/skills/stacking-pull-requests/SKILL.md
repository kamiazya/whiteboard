---
name: stacking-pull-requests
description: Operates a stack of dependent pull requests in the whiteboard repo with the gh-stack extension — creating a stack across architecture layers, keeping it rebased as main moves, and landing it. Use when a change spans several layers that must merge in order (a shared package under an MCP tool under a web surface), when the user says stacked PR / stack / 積む / スタック, or when a branch's base is another feature branch rather than main. For deciding WHETHER to stack, see the mode table in .claude/rules/dev-flow.md.
---

# Stacking pull requests

`gh stack` (GitHub's stacked pull requests, public preview since 2026-07-30) turns a
chain of dependent branches into one reviewable stack: each PR shows only its own
layer's diff, reviewers work in parallel, and merging is atomic up to whichever PR
you pick.

**Whether to stack at all is a `dev-flow.md` decision, not this skill's.** This skill
is the operating procedure once the answer is yes.

## Prerequisite

```bash
gh extension install github/gh-stack
```

One-time per machine. `gh stack --help` lists every subcommand; the ones below are
the whole day-to-day surface.

## Stack order is not a choice here

This repo's dependency direction is already fixed by `.claude/rules/architecture-map.md`,
and a stack must follow it — a lower layer cannot depend on a higher one:

```
canvas-model → canvas-codec / canvas-render / canvas-ports → canvas-workspace
             → server-core → mcp-server | apps/web
```

The composition roots (`mcp-server`, `apps/web`) are therefore always at the TOP of a
stack, never the bottom. That is what makes "split the MCP, CLI and web parts into
separate PRs" mechanical rather than a judgement call: the shared package goes first,
the surface that consumes it goes above it.

Two consequences worth stating:

- **Each PR loads its own layer's review criteria.** `.claude/rules/package-*.md` are
  path-scoped, so a `canvas-model` PR carries the Zod-discipline rules while an
  `apps/web` PR carries the accessibility and reachability ones. The per-layer review
  concerns follow the stack for free.
- **The bottom layers answer `userReach` with `foundation:`, and the named follow-up
  is the PR above.** That is the strongest form of that sentinel — a reviewable
  reference instead of "wired later".

## Creating a stack

Bottom-up, one branch per layer:

```bash
gh stack init render-scene-digest mcp-export-digest   # bottom first, then above it
gh stack view                                          # confirm the order
```

Work on the bottom branch, commit, then move up:

```bash
gh stack bottom          # or: gh stack down / up / top / trunk to navigate
# ...edit, commit...
gh stack up
# ...edit, commit...
```

To append a layer later:

```bash
gh stack add apps-web-digest-panel
```

Then publish the whole stack:

```bash
gh stack submit
```

Interactive by default: a single editor screen where you title each PR and choose
draft state, submitted together with `Ctrl+S`. `--auto` skips the editor and creates
drafts with generated titles — **do not use `--auto` here**, because every title is a
future squash-commit message and must be a Conventional Commit (see the PR Title Rule
in AGENTS.md). `gh stack submit` re-run later updates existing PRs and their bases.

In a non-interactive session (no editor), `gh stack submit` behaves like `--auto`:
it creates the PR with a generated, non-Conventional title (the branch name with
hyphens as spaces). Fix it immediately with `gh pr edit <n> --title "feat(...): ..."`
— the `pr-title` check listens for the `edited` event, so the corrected title
re-validates on its own; nothing else re-runs. Do NOT `gh run rerun` a failed title
check: reruns re-read the ORIGINAL event payload and can never see the new title.

## Keeping the stack current

When `main` moves:

```bash
gh stack sync
```

That fetches, fast-forwards the trunk, cascade-rebases each branch onto **its parent**
(not onto main), and pushes every branch atomically with `--force-with-lease --atomic`.

Never hand-rebase the layers with `git rebase main` per branch — that rebases each one
onto the trunk instead of its parent, flattening the stack, and the per-branch force
pushes are not atomic. Resolve conflicts bottom-up: a conflict in a lower layer
reappears in every layer above it until it is fixed at the bottom.

`gh stack rebase --no-trunk` does only the inter-branch rebases when the trunk is
already current.

## Landing a stack

```bash
gh stack merge <pr-number> --squash     # everything up to and including that PR
gh stack merge --yes --squash           # the whole stack, no prompt
```

Atomic and all-or-nothing: if any PR in the range cannot merge, none of them do.
Upper PRs that stay behind retarget themselves automatically.

**Always `--squash`.** release-please derives the version bump and changelog from
squash-merge commit subjects, so a merge commit or a rebase merge breaks that contract.

Two limits of the preview, both verified against `gh stack merge --help`:

- **Bypassing merge requirements is not supported for stacks.** Branch protection and
  repository rules are evaluated by GitHub when the merge runs. The local
  `LEFTHOOK=0` habit is unrelated — that is a pre-push hook, not a merge requirement.
- Merge-queue support is still rolling out. On a queued base branch the stack is added
  to the queue rather than merged directly.

## Repo-specific notes

**The `gh pr create` guard does not fire on `gh stack submit`** — its matcher is
`/\bgh\s+pr\s+create\b/`. That is correct rather than a gap: the guard blocks a branch
that is behind `origin/main`, and every layer above the bottom of a stack is
legitimately behind main because it is based on the layer below. Keep the *bottom* of
the stack current with `gh stack sync`; the rest follows.

**Stacks are a single-worktree flow.** `dev-flow.md`'s parallel model gives each
concurrent dev-loop its own worktree because those lanes are scope-disjoint. A stack is
the opposite: deliberately dependent and linear. Build it in one checkout and navigate
with `gh stack up` / `down` rather than creating a worktree per layer.

**Per-layer verification still applies.** Each PR is reviewed as its own change, so
each one carries its own nearest-layer tests. A stack does not let a lower layer defer
its tests to the PR above it.

## Reference

- `evaluations.md` — the three scenarios this skill exists to make succeed, with the
  baseline failure each one closes.
- `gh stack <command> --help` — authoritative for flags; this file covers the path.
- Documentation: https://gh.io/stacks
