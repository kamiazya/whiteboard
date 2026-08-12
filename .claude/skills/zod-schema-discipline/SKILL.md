---
name: zod-schema-discipline
description: How to keep Zod as the single source of truth for any contract that crosses a process boundary in the whiteboard repo (MCP tool input/output, Hono routes, persisted JSON, websocket/daemon payloads). Use when adding or editing an MCP tool, a route response, or a persisted-JSON parser, or when fixing a schema-vs-runtime drift. Covers the create_frame bug pattern and the mutation-check recipe.
---

# Zod Schema Discipline

Zod is the **single source of truth** for every contract that crosses a process boundary. A schema and a separately hand-written TypeScript type that travel together WILL drift — one side changes, the type-check passes, and only the runtime validator (or nothing) catches it.

## The failure pattern (avoid)

A Zod schema declared once, plus a hand-written `interface`/return type describing the same shape:

```ts
export const xxxOutputSchema = z.object({ assignedMembers: z.array(z.string()) })
export interface Xxx { assignedMembers: number }   // drifts silently — shipped the create_frame bug
execute: async (...): Promise<Xxx> => ...
```

## The rule

Derive the type FROM the schema; never write it twice.

```ts
export const xxxOutputSchema = z.object({ ... })
export type Xxx = z.infer<typeof xxxOutputSchema>
// or annotate the handler directly:
execute: async (...): Promise<z.infer<typeof xxxOutputSchema>> => ...
```

Concrete rules:
- MCP tools register through `registerToolWithAnnotations` (generic over `O extends z.ZodTypeAny | undefined`, constrains the handler to `Promise<ToolHandlerReturn<O>>`). Never widen `outputSchema` to `unknown`/`any` or cast around the binding.
- Annotate each `tools/*.ts` `execute` return as `Promise<z.infer<typeof xxxOutputSchema>>` (or import the inferred type). No parallel hand-written interface.
- Persisted JSON (`palette`, `manifestJson`, `frontiers`, …) → declare a Zod schema next to the parser and hydrate via `schema.parse(...)`, not a cast.
- Hono routes consumed by typed clients → declare the response schema once; both server and client import `z.infer<typeof responseSchema>`.
- If a contract is genuinely `z.unknown()`/`z.any()`, write a comment marking that intent so it reads as deliberate.

## Verify (always)

- Compile-time guard: `pnpm --filter @kamiazya/whiteboard-mcp typecheck` and `pnpm build`.
- Runtime guard for MCP tools: extend `pnpm smoke:e2e` (`scripts/smoke/mcp-e2e-smoke.mjs`) to call any new/changed tool at least once — the MCP SDK validates `structuredContent` against `outputSchema` at runtime, catching drift the type system can't see.
- **Mutation-check** when fixing a drift: revert the production fix, confirm `pnpm build` OR `pnpm smoke:e2e` fails, then restore. Commit the test/smoke step that would have caught it.
