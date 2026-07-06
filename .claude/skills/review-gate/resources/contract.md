# Contract

Zod is the single source of truth for every contract that crosses a process
boundary. A schema and a hand-written type traveling together WILL drift —
this is the `create_frame` `assignedMembers: number` vs `string[]` bug class.

## Criteria

### 1. `outputSchema` registered and used

Check:
- Does the tool's `outputSchema` get registered via
  `registerToolWithAnnotations` in `index.ts` (not widened to `unknown`, not
  cast around the generic binding)?
- Does the `tools/*.ts` `execute` return type read
  `Promise<z.infer<typeof xxxOutputSchema>>` rather than a separately
  maintained interface?

### 2. `inputSchema` validates before use

Check:
- Is the MCP tool's `inputSchema` actually consulted before the handler acts
  on the argument, or does the handler read raw `args` fields directly?

### 3. No unexplained `z.any()`/`z.unknown()`

Check:
- Every `z.any()`/`z.unknown()` in a schema touched by this diff has a
  comment marking the loose boundary as deliberate — otherwise it's
  papering over an actual shape the author didn't model.

### 4. New tool extends the runtime smoke guard

Check:
- If this diff adds or changes an MCP tool's `outputSchema`, was
  `pnpm smoke:e2e` (`scripts/smoke/mcp-e2e-smoke.mjs`) extended to call it at
  least once? The MCP SDK validates `structuredContent` against
  `outputSchema` at runtime — the smoke is the last line of defense against
  drift the type system can't see.

### 5. Mutation-check on a schema-vs-runtime fix

Check:
- When this diff fixes a schema/runtime drift, does it also add/extend the
  test or smoke step that would have caught it? (Revert the production fix
  → `pnpm build` or `pnpm smoke:e2e` should fail → restore.)
