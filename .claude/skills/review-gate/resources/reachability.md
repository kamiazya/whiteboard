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
