# Dev experience

Friction a new contributor hits on a clean clone, and docs/scripts that have
drifted from reality.

## Criteria

### 1. Setup steps that fail on a clean clone

Check:
- Does README/CONTRIBUTING describe an install/bootstrap sequence that
  actually works from `git clone` (no assumed local state)?
- Do referenced scripts (`pnpm mcp:http:dev`, `pnpm docs:snapshots`, etc.)
  exist and run without an undocumented prerequisite?

### 2. Flaky or missing local services

Check:
- Does a documented local dev flow depend on a service (daemon, port) that
  isn't reliably started by the documented command?

### 3. Missing or stale docs for a real workflow

Check:
- Does AGENTS.md / a skill / a README section describe a command, flag, or
  file path that no longer exists or behaves differently now?
- Does `.claude/` tooling (a workflow, agent, or skill) reference a command,
  path, or flag that has since changed? Contributor-facing docs and scripts
  both fall under this dimension. Deeper drift within the `.claude/` asset
  ecosystem itself (stale cross-references, frontmatter validity, skill
  overlap) is the `ai-assets` dimension's job — forward findings there.

### 4. Friction discovered but never resolved

Check:
- Are there stale entries under `tmp/issues/` describing dev-experience
  friction that was never fixed or filed as a task?
