# Reachability

Code that builds, typechecks, and passes its tests can still deliver nothing:
nothing registers it, mounts it, renders it, or routes to it, so no user ever
arrives at it. Tests pass because they call the new code directly — which is
exactly why the other dimensions do not catch this.

A foundation-only slice is legitimate. A *silently* foundation-only slice is
the defect: it reads as finished, gets merged, and the gap surfaces later as
rework. This dimension only asks that the difference be visible.

## Criteria

### 1. New capability has an entry point in this same diff

Check:
- For each new user-facing capability, does the diff contain the line that
  makes it reachable — not just its implementation?
- If it does not, does the PR body / commit message say so explicitly and
  name the follow-up that wires it? An unwired slice with no named successor
  is a finding; an unwired slice declared as such is not.
- Does at least one test or smoke step go *through* that entry point rather
  than calling the implementation directly? A test that imports the function
  proves the function works, never that anyone can reach it.

### 2. The repo's specific wiring points are present

Check, per surface touched:
- **MCP tool**: registered through `registerToolWithAnnotations`, exported
  from the tools index, and called at least once by `pnpm smoke:e2e`
  (`scripts/smoke/mcp-e2e-smoke.mjs`) — AGENTS.md requires the smoke step for
  every new tool, and it is what proves the tool is actually reachable over
  the wire rather than merely defined.
- **HTTP route**: mounted on the Hono app returned by `createServer`, not
  only defined in a route module.
- **React component / hook** (`apps/web`, `canvas-viewer`): rendered by a
  parent that is itself mounted, reachable from a real screen — not only
  exported and unit-tested.
- **Scene / layout function** (`canvas-render`): called by
  `layoutSpatialCanvas` or a renderer on a path a real canvas takes.
- **CLI flag / env var / config key**: parsed AND read by the code that acts
  on it.
- **Skill / workflow / agent** (`.claude/**`): referenced from the
  `dev-flow.md` index or another entry point, so it is discoverable rather
  than orphaned.

### 3. Removal leaves no orphaned entry point

Check:
- When the diff removes a capability, does it also remove what pointed at it
  (menu item, route, registration, doc line), rather than leaving a
  reachable path to something that no longer works?

## The design answers this dimension re-asks

The full text of the three dev-loop design fields; `.claude/rules/dev-flow.md` keeps the short form.

**Reach and worth are designed, not discovered in review.** Beside `scope` (what you intend to edit), dev-loop's `DESIGN_SCHEMA` requires three answers `scope` cannot give, all judged by PlanReview — the first two re-asked of the diff by the `reachability` review dimension:

- **`blastRadius`** — who else inside the codebase this edit reaches, each caller flagged for whether a test would fail if it broke. `typecheck` already catches *signature* breaks; this is for the caller that still compiles, changed behavior, and has nothing watching it. Use an impact-graph MCP tool (`get_impact_radius_tool`) when connected, else grep. Sentinels: `none:` (leaf change), `unavailable:` (no such tool on this machine — accepted without argument; nobody is gated on optional local tooling).
- **`userReach`** — whether it reaches a USER at all: the registration, route, rendering parent, or flag-read that this increment adds. Built-but-unwired passes every other gate, because the tests pass *precisely by calling the new code directly*. A foundation-only slice is fine; a silently foundation-only one is the defect. Sentinel: `foundation: <reason> — wired by <named follow-up>`, rejected if the follow-up is too vague to file.
- **`benefit`** — what the change is WORTH, in the currency that picks its instrument. `delta:`
  (a metric moves) is a bench or a scoreboard; `relocation:` (work leaves the path a person
  waits on) is what that path stops doing PLUS what the handover costs; `elimination:` (a class
  of mistake stops being possible) is a count or a mutation check; `obvious:` is worth visible in
  the diff. PATTERN-enforced, because a field asking someone to choose a column is one they
  answer in prose otherwise. What it prevents: a relocation pointed at a stopwatch, which cannot
  see one — and reports a null that reads as a verdict on the change rather than on the probe.
  Worked cases: `measured-change`.

`codebase-auditor`'s `wiring-gaps` dimension stays the periodic sweep for whatever still slipped through.
