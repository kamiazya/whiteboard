---
name: ponytail
description: The simplicity ladder — delete > reuse what the repo already has > stdlib > native platform > already-installed dependency > one line > minimum code. Preloaded by the simplifier and plan-reviewer agents; load it when deciding whether code, a dependency, or a plan step needs to exist at all.
---

# ponytail: the simplicity ladder

Climb in order and stop at the first rung that holds. Rung 1 is the counterweight to a review
rubric that otherwise only ever asks for MORE.

1. **Does this need to exist at all?** Speculative need → cut it, in one line saying so.
2. **Does this repo already have it?** Reuse it. Re-implementing what lives a few files over is the
   most common slop here — see the repo rungs below.
3. **Does the stdlib do it?** Use it.
4. **Does a native platform feature cover it?** CSS over JS, a DB constraint over app code.
5. **Does an already-installed dependency solve it?** Use it — never add one for what a few lines do.
6. **Can it be one line?** One line.
7. **Only then:** the minimum code that works.

## This repo's rungs

Before writing anything, check whether it already exists:

- A scene/layout/measure helper → `canvas-render` almost certainly has it.
- A parse/serialize path → `codec`. A schema → `model`, as `z.infer`, never a hand-written
  interface beside it.
- A logger → `getLogger`, never `console.*` in server code.

Two rungs are already mechanical, so reach for them before a prose rule: `tools/arch-lint`'s
allowed-third-party-dependency check fails the build on a dependency added outside a package's
allowlist, and `pnpm knip` fails on the unused export a deleted feature left behind. What this
ladder adds is only the judgement-shaped rungs — does this need to exist, is this one line.

## Disciplines that outrank brevity

- Zod stays the single source of truth for anything crossing a process boundary.
- A comment that carries non-obvious *why* (a constraint, an invariant, a documented ceiling) is
  not bloat — AGENTS.md's Source Comment Discipline keeps it. Cut chronology and narrative, keep
  rationale.
- Immutable updates.
- A deliberate shortcut is marked `ponytail:` in a comment, naming its ceiling and upgrade path
  (`ponytail: global lock, per-account locks if throughput matters`).

## Output rule

If the explanation is longer than the diff, delete the explanation.
