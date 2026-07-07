# Test gaps

Critical paths with no nearest-layer test, skipped tests, and contracts with
no conformance check.

## Criteria

### 1. Critical paths with no nearest-layer test

Check:
- For a route, MCP tool, or store mutation that affects persisted data, is
  there at least one `mcp-node` (or equivalent) test exercising it directly?
- Is browser-only interaction behavior (popovers, focus, restore flows)
  covered only in jsdom, when the real risk is browser-specific?

### 2. Skipped or disabled tests

Check:
- Grep for `.skip`, `xfail`, `test.todo`, or a commented-out `it(...)` block.
- Is there a tracked reason (issue/comment) or did it just get silently
  disabled and forgotten?

### 3. Contracts with no conformance test

Check:
- Does a Zod schema crossing a process boundary have at least one test that
  would fail if the runtime payload and the schema diverged?
- For a mutation-checkable fix (per AGENTS.md), is there evidence the fix
  was mutation-checked (revert → test fails → restore)?

### 4. New public functions/components with no coverage

Check:
- Grep the diff history (or `git log -p` on recently added files) for new
  exported functions/components with no matching test file.
