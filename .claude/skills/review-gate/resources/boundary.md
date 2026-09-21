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

### 6. A re-export from another package's ROOT barrel

A barrel re-export is an import of that package's index, so it drags the
index's whole module graph. No boundary test can see this — the edge is
legal and the types are right — and only the bundle gate can, after a build.
Measured: re-exporting `apiErrorReason` from `@kamiazya/whiteboard-server-core`
put hono, loro-crdt, canvas-render and search into apps/web's entry chunk,
421.4 KB gzip against a 152 KB budget, because one critical-path module read
it. From `.../api-errors` instead: 148.8 KB.

Check:
- Does a new or moved re-export name a package ROOT? If any critical-path
  module reaches it, it needs a subpath — and the subpath needs an `exports`
  entry in the producing package.
- Does the producing module import only what the consumer can afford? A
  contract module that imports zod and nothing else is safe from any root; a
  barrel is not.
