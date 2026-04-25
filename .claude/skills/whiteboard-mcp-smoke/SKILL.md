---
name: whiteboard-mcp-smoke
description: A skill that standardizes whiteboard MCP and daemon verification. Use it after changing tools, routes, WebSocket behavior, daemon startup, checkpoints, export, or viewport logic when you need to decide what must be restarted and run the right smoke checks. Also use it when the user asks to verify behavior, run smoke tests, confirm things without restarting, or check whether MCP is broken.
---

# MCP Smoke Verification Pattern

This repository splits verification targets into two categories.

- **Server/daemon-side changes**
  Example: `src/server/**`, `src/app/hooks/useWhiteboardSync.ts`, `src/daemon/**`
- **MCP schema/registration-side changes**
  Example: descriptions, schemas, or registration in `src/server/mcp/index.ts` and `src/server/mcp/tools/**`

## Decide First

- If you only touched `src/server/**` or `src/daemon/**`:
  - Restarting the Claude session is usually unnecessary
  - Verify through a watched daemon started with `pnpm --filter @kamiazya/whiteboard-mcp daemon:dev` or a `WHITEBOARD_DEV=1` path
- If you touched `src/server/mcp/**`:
  - The MCP client must reconnect
  - Do not treat daemon watch mode as sufficient

## Procedure

### 1. Match the startup path to the change type

When repeatedly verifying server/daemon-side changes, use this in another terminal.

```bash
pnpm --filter @kamiazya/whiteboard-mcp daemon:dev
```

Meaning:

- Runs `tsx watch src/server/index.ts --daemon`
- Server, route, store, and daemon changes restart automatically
- MCP schema changes are not picked up

### 2. Unit Tests

Start with focused tests for the touched area. If broader coverage is not needed yet, leave full `pnpm test` for later.

```bash
pnpm test
```

Stop there if it fails.

### 3. Typecheck

```bash
pnpm typecheck
```

### 4. Stdio Smoke

```bash
pnpm smoke:e2e
```

`scripts/mcp-e2e-checkpoint.mjs` launches stdio MCP in a subprocess and verifies at least the following.

- `canvas_create`
- `annotate`
- `canvas_inspect`
- `checkpoint_save`
- `checkpoint_restore`
- `viewport_set` returning `no_client`
- `export_png` returning `no_client`

If the final line is `[e2e] ALL OK`, the MCP wrapper and route wiring are basically connected correctly.

### 5. LLM Smoke Only When Needed

```bash
pnpm smoke:claude
```

This consumes quota. Use it only when you need to confirm that the LLM can call tools correctly through descriptions and schemas.

## How To Read Failures

- `RPC <method> timed out`
  - MCP failed to start, or stdio is blocked
- If the target tool does not appear in `tools/list`
  - It is likely missing from `src/server/mcp/index.ts`
- If you get an error other than `no_client`
  - A guard likely regressed in `routes/export.ts`, `routes/viewport.ts`, or `routes/ws.ts`
- If checkpoint restore returns the wrong element count
  - There is likely a regression in `routes/canvas.ts` or `store/checkpoint-store.ts`

## Working Rules

- After server/daemon changes, start from the `daemon:dev` path and try verification without restarting Claude
- If you touched MCP schema or registration, explicitly state that a restart is required
- In general, progress through `test -> typecheck -> smoke:e2e`, stopping on failures
- When you add a new tool, add one case to `scripts/mcp-e2e-checkpoint.mjs` when feasible
