# Evaluations

## Contents
- How to use these
- 1. Create a stack across layers
- 2. Land a stack
- 3. Absorb a moved trunk

Written before the skill body, per Anthropic's skill-authoring guidance: each one
records a failure observed (or predicted with a named cause) WITHOUT the skill, so
the instructions stay the minimum that closes the gap rather than documentation of
imagined requirements.

## How to use these

Run the query against a fresh session with the skill loaded. The expectations are
behavioural, not textual — the point is what the session *does*.

## 1. Create a stack across layers

**Query:** "Add a `sceneDigest` field to the MCP export tool. It needs a new
canvas-render helper, then the mcp-server tool change. Split it into reviewable PRs."

**Baseline failure without the skill:** opens two independent PRs both targeting
`main`, or targets the second at the first with `gh pr create --base` — which
produces two linked PRs but *no GitHub stack*: no stack map, no atomic merge, and
the upper PR's diff shows the lower PR's commits too.

**Expected with the skill:**
- Orders the branches bottom-up by the `architecture-map.md` dependency direction
  (canvas-render below mcp-server), never the reverse.
- Uses `gh stack init` / `gh stack add`, then `gh stack submit` — not bare
  `gh pr create`.
- Each PR title is a Conventional Commit, because each is squash-merged later.

## 2. Land a stack

**Query:** "The bottom two PRs of the stack are approved and green. Land them."

**Baseline failure without the skill:** merges the bottom PR with `gh pr merge`,
then hand-retargets the next PR's base and rebases it — several steps, each a
chance to force-push over someone, and the stack on GitHub is left inconsistent.

**Expected with the skill:**
- `gh stack merge <pr-number> --squash` — one atomic operation up to that PR.
- Chooses squash explicitly, because release-please reads squash-merge titles.
- Does not attempt to bypass merge requirements; stacks do not support it.

## 3. Absorb a moved trunk

**Query:** "main has moved several commits. Update my stack."

**Baseline failure without the skill:** checks out each branch and runs
`git rebase main` plus a per-branch `git push --force`, which rebases each layer
onto the trunk instead of onto its parent — flattening the stack, and force-pushing
non-atomically so a failure halfway leaves the remote inconsistent.

**Expected with the skill:**
- `gh stack sync` — fetch, cascade-rebase each branch onto its *parent*, then push
  all branches atomically with `--force-with-lease --atomic`.
- Resolves conflicts bottom-up, lowest layer first.
