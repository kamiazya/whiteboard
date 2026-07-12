---
name: whiteboard-smoke
description: Use this after changing Excalidraw MCP to choose and run the right repo-specific smoke test for startup verification, tool wiring, checkpoint restore, templates, and Claude/Codex subprocess paths. It helps decide which `scripts/mcp-*.mjs` or `pnpm smoke:*` command to use, while keeping sandbox and quota constraints in mind and choosing the smallest effective verification path.
---

# whiteboard-smoke

This repo already packages its smoke tests as scripts. **Do not rewrite ad-hoc verification commands every time.**
Choose and run the smallest smoke test that matches the changed area.

Open [`references/smoke-matrix.md`](./references/smoke-matrix.md) first and select only the smoke checks that match the current change.

## Ground Rules

- Start with the **smallest smoke** first. Do not jump straight to quota-consuming checks
- If a smoke test fails, fix that failure before moving to a larger one
- `Claude` and `Codex` subprocess smoke tests consume API quota, so they are for manual verification rather than CI
- `Codex` subprocess smoke may fail inside the sandbox because of `~/.codex/sessions` permissions. If so, rerun it outside the sandbox
- For `viewport_set`, `no_client` while the browser is disconnected is an **expected success condition** in E2E smoke. `export_canvas` falls back to headless rendering instead, so its E2E coverage exercises the real render path with no browser connected

## Standard Flow

1. Pick one smoke test that matches the changed area
2. If it passes, add only the adjacent smoke checks you need
3. If the change reaches subprocess integration, add `smoke:claude` or `smoke:codex`
4. Finish with `pnpm typecheck`

## Commands

Run these from the repo root.

```bash
pnpm smoke
pnpm smoke:e2e
pnpm smoke:template
pnpm smoke:claude
pnpm smoke:codex
pnpm typecheck
```

## How To Choose

- To catch entrypoint, export, or import breakage: `pnpm smoke`
- To verify canvas, checkpoints, routes, or tool wiring: `pnpm smoke:e2e`
- To verify templates only: `pnpm smoke:template`
- To verify Claude Code compatibility as a zero-context client: `pnpm smoke:claude`
- To verify Codex subprocess behavior, schema-bound output, and real file persistence: `pnpm smoke:codex`

## Expected Results

- `smoke`: the process does not die immediately within 3 seconds
- `smoke:e2e`: checkpoint save / restore, validation errors, and `no_client` rejection all behave correctly
- `smoke:template`: built-in templates, file templates, and validation errors all behave correctly
- `smoke:claude`: the final line includes a checkpointId
- `smoke:codex`: returns a JSON object and leaves real canvas / checkpoint `.loro` files in the tmp directory

## When Manual Checks Are Required

- When you need to verify success paths that require a connected browser
- When you need to inspect actual `export_canvas` PNG rendering in a connected browser
- When you need to verify the appearance or readability on the Excalidraw canvas itself

In those cases, do not treat smoke alone as sufficient. Open the browser and verify the real UI.
