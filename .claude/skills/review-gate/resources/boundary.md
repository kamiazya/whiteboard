# Boundary

Layers exist so each side can change independently. A cross-layer import or
an unvalidated payload crossing a boundary erodes that independence.

## Criteria

### 1. No cross-layer imports

Check:
- Does `apps/web` import anything from `packages/mcp-server/src/server/**`
  internals (or vice versa) instead of a published/shared contract?
- Does UI code reach into daemon-only or storage-only internals directly?

### 2. HTTP response shapes go through shared contracts only

Check:
- Does a Hono route's response shape get consumed by a typed client via a
  shared `z.infer<typeof responseSchema>`, or does the client define its own
  parallel type?

### 3. Persisted JSON parsed through a schema

Check:
- Does code reading `palette`, `manifestJson`, `frontiers`, or similar
  persisted JSON hydrate via `schema.parse(...)`, or does it cast a raw
  `JSON.parse(...)` result?

### 4. Origin/scope checks stay at the boundary

Check:
- Is origin validation, scope enforcement, or auth-boundary logic performed
  once at the entry point, not re-implemented or bypassed deeper in the call
  stack?

### 5. Worktree/cwd-aware code stays path-correct

Check:
- Does code that runs against a worktree (`cwd`-aware scripts, daemon
  registry entries) consistently use the passed `cwd`/absolute path instead
  of assuming the process's own `process.cwd()`?
