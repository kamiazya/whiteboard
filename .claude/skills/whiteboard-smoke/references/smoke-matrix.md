# Smoke Matrix

This repo splits smoke tests into five kinds. Pick the **smallest one** that matches the changed area.

## Change Area -> What To Run

| Change | Run First | Add Next |
|---|---|---|
| MCP entrypoint / import-export / crash right after startup | `pnpm smoke` | `pnpm smoke:e2e` |
| Canvas routes / checkpoints / store / MCP tool wiring | `pnpm smoke:e2e` | `pnpm smoke:claude` or `pnpm smoke:codex` if needed |
| Claude Code subprocess compatibility | `pnpm smoke:claude` | `pnpm typecheck` |
| Codex subprocess compatibility / strict output / tmp persistence | `pnpm smoke:codex` | `pnpm typecheck` |
| Rendering quality that requires a connected browser | Manual check after smoke | open the canvas in a browser, then export |

## What Each Smoke Test Actually Runs

- `pnpm smoke`
  - `packages/mcp-server/scripts/smoke/mcp-smoke.mjs`
  - Verifies that the MCP server does not die immediately within 3 seconds
- `pnpm smoke:e2e`
  - `packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs`
  - Verifies canvas, version save/restore, and route wiring by calling stdio JSON-RPC directly
  - `packages/mcp-server/scripts/smoke/mcp-template-smoke.mjs`
  - Calls the template tool directly, mocking fetch and validating behavior
- `pnpm smoke:claude`
  - `packages/mcp-server/scripts/smoke/mcp-claude-cli-smoke.mjs`
  - Verifies whether the Claude subprocess can reach checkpoint creation from a zero-context start
- `pnpm smoke:codex`
  - `packages/mcp-server/scripts/smoke/mcp-codex-cli-smoke.mjs`
  - Verifies whether the Codex subprocess returns schema-bound JSON and leaves canvas / checkpoint files in the tmp data dir

## Notes For Codex Smoke

- Inside the sandbox it may fail because it cannot write to `~/.codex/sessions`
- If that happens, rerun it outside the sandbox
- Success does not mean only “JSON was returned.” Confirm that real `.loro` files exist as well
- `KEEP_SMOKE_TMP=1 pnpm smoke:codex` keeps the tmp directory for later inspection

## Common Failure Points

- `vitest: command not found`
  - Prefer the root command through the package manager instead of running the script directly
- `No browser client`
  - This is an expected failure in `smoke:e2e`. It is separate from browser success verification
- `~/.codex/sessions` permission denied
  - This is a Codex sandbox limitation. Do not confuse it with a repo bug
- Claude / Codex subprocess fails because of quota or auth
  - Suspect client environment issues before suspecting the script itself
