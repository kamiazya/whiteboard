# Architecture

Leaky or violated seams, boundary breaks, god modules, and abstractions that
don't pay for themselves.

## Criteria

### 1. Cross-layer boundary violations

Check:
- Does browser/client code import server-internal modules (not the shared
  API contract)?
- Does `apps/web` import from `packages/mcp-server/src/server/**` directly
  instead of through an HTTP/API boundary?

### 2. God modules

Check:
- Any single file mixing unrelated responsibilities (routing + persistence +
  business logic in one place) that keeps growing instead of splitting?
- Cross-reference with the maintainability dimension's file-size check, but
  flag here specifically when the growth is due to poor seams, not just length.

### 3. Circular dependencies

Check:
- Grep import graphs for A → B → A cycles across module/package boundaries.
- Does a cycle force awkward lazy-imports or `any`-typed escape hatches to
  break it?

### 4. A contract defined in two places

Check:
- Is there a hand-written TypeScript interface describing the same shape as
  a Zod schema, a client-side type duplicating a server response shape, or
  two independent parsers for the same persisted format?
- (Deep-dive on the runtime-drift risk of this pattern is the `contract-drift`
  dimension; flag here only the structural "two sources of truth" shape.)

### 5. Abstractions that don't pay for themselves

Check:
- A single-implementation interface/repository/factory with no second
  implementation and no near-term plan for one.
- A generic layer introduced for "future flexibility" that adds indirection
  without a concrete second caller today.
