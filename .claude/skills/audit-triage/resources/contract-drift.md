# Contract drift

A schema and a hand-written type or a second parser traveling together WILL
drift — this is the `create_frame` `assignedMembers: number` vs `string[]`
bug class.

## Criteria

### 1. Hand-written interface paralleling a Zod schema

Check:
- Grep for `interface`/`type` declarations near a `z.object(...)` schema
  describing the same shape.
- Does the handler/execute return type use `z.infer<typeof xxxSchema>`, or a
  separately maintained interface?

### 2. Casts around process boundaries

Check:
- Grep for `as unknown as`, `as any`, or a bare `as X` cast on data crossing
  an MCP tool boundary, HTTP route, or persisted-JSON read.
- Is there a comment marking a deliberate `z.unknown()`/`z.any()` boundary,
  or is the cast silently papering over an actual type mismatch?

### 3. Persisted JSON parsed without a schema

Check:
- Does code read `palette`, `manifestJson`, `frontiers`, or similar
  persisted JSON via `JSON.parse(...)` directly, or does it hydrate through
  `schema.parse(...)`?

### 4. Response shapes typed separately on client and server

Check:
- For a Hono route consumed by a typed client, do both sides import the same
  `z.infer<typeof responseSchema>`, or does the client define its own
  parallel type?

### 5. Missing smoke coverage for new/changed tools

Check:
- When an MCP tool's `outputSchema` changed, was `pnpm smoke:e2e`
  (`scripts/smoke/mcp-e2e-smoke.mjs`) extended to exercise it, so a runtime
  drift the type system can't see gets caught?
