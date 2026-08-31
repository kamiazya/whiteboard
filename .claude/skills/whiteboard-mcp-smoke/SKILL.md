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

`scripts/smoke/mcp-e2e-smoke.mjs` launches stdio MCP in a subprocess and calls
every tool in `COVERED_TOOLS`, asserting each one's `structuredContent` against
its `outputSchema`. It also exercises the error paths in `ERROR_PATH_ONLY_TOOLS`
and the no-browser cases — a viewport set answering `no_client`, and a scene
render succeeding through headless rendering with nothing connected.

**Read the covered set from `server/mcp/mcp-smoke-coverage.ts`, not from here.**
That file is the source of truth and `smoke-tool-list-parity.test.ts` keeps it in
step with what the smoke actually calls; a copy in this skill is a second list
with nothing checking it. The copy that used to sit here named eight tools, and
the tool renames of ADR-0009 had left every one of them unregistered — a skill is
instructions to a future session, so a wrong name here is misdirection rather
than noise.

If the final line is `[e2e] ALL OK`, the MCP wrapper and route wiring are basically connected correctly.

### 5. LLM Smoke Only When Needed

```bash
pnpm smoke:claude   # Claude subprocess, from a zero-context start
pnpm smoke:codex    # Codex subprocess: schema-bound JSON output + real files on disk
```

Both consume quota, so neither runs in CI. Reach for them only to confirm an
LLM can call the tools through their descriptions and schemas.

`smoke:codex` fails inside a sandbox because it cannot write `~/.codex/sessions`.
That is the sandbox, not a repo bug — rerun it outside. And returning JSON is
not the pass condition on its own: confirm real `.loro` files were left behind.
`KEEP_SMOKE_TMP=1 pnpm smoke:codex` keeps the tmp directory to look at them.

## Which smoke, and in what order

Start with the smallest that covers the changed area; add the next only if the
first passes. Do not open with a quota-consuming one.

| Changed | Run first | Add next |
|---|---|---|
| entrypoint, imports, a crash right after startup | `pnpm smoke` (the process survives 3s) | `pnpm smoke:e2e` |
| canvas routes, versions, store, MCP tool wiring | `pnpm smoke:e2e` | `smoke:claude` / `smoke:codex` if it reaches subprocess integration |
| Claude Code subprocess compatibility | `pnpm smoke:claude` | `pnpm typecheck` |
| Codex subprocess, strict output, tmp persistence | `pnpm smoke:codex` | `pnpm typecheck` |
| rendering quality needing a connected browser | smoke proves nothing here | open the browser and look |

`pnpm smoke:all` is `smoke:e2e && smoke:claude`, not everything.

## How To Read Failures

- `RPC <method> timed out`
  - MCP failed to start, or stdio is blocked
- If the target tool does not appear in `tools/list`
  - It is likely missing from `src/server/mcp/index.ts`
- If you get an error other than `no_client`
  - A guard likely regressed in `routes/export.ts`, `routes/viewport.ts`, or `routes/ws.ts`
- If version restore returns the wrong element count
  - There is likely a regression in `routes/canvas.ts` or `store/version-store.ts`

## Working Rules

- After server/daemon changes, start from the `daemon:dev` path and try verification without restarting Claude
- If you touched MCP schema or registration, explicitly state that a restart is required
- In general, progress through `test -> typecheck -> smoke:e2e`, stopping on failures
- When you add a new tool, add one case to `scripts/smoke/mcp-e2e-smoke.mjs` when feasible
