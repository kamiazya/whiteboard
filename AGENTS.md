# Project Instructions

Use this repo's standard development loop for every feature, bug fix, or refactor:

1. Start with the smallest failing test at the nearest layer.
2. Make the smallest patch that turns it green.
3. Manually verify the real behavior in a running app or browser.
4. Lock the verified user flow into `mcp-browser` or a broader E2E test when browser-mode is not enough.

## Test Layer Selection

- Use `mcp-node` for pure functions, stores, routes, server behavior, and persistence logic.
- Use `mcp-jsdom` for React components and hooks when browser layout and pointer behavior are not the core risk.
- Use `mcp-browser` for popovers, dialogs, scroll, focus, keyboard, pointer behavior, restore flows, and other real browser interactions.
- Promote to E2E when the bug depends on real routes, server composition, websocket timing, persistence order, or multi-step page flows.

Do not jump to broad E2E first if a smaller failing test can isolate the bug.

## Required Workflow

### 1. Write the red test first

- Reproduce the bug or target behavior before changing production code.
- Keep the first failing case as small and local as possible.

### 2. Turn it green locally

Run the narrowest project first:

```bash
pnpm test --project mcp-node
pnpm test --project mcp-jsdom
pnpm test --project mcp-browser
```

After the targeted test passes, run the broader suite that covers the touched area.

### 3. Manually verify the real behavior

- For UI work, open the real screen and confirm the behavior directly.
- Prefer Chrome DevTools MCP or Playwright MCP when available to inspect DOM, console, network, and visible behavior.
- If the changed flow is represented by a project skill under `./skills/*`, read the relevant `SKILL.md` and dogfood the real MCP/skill flow instead of verifying only through mocks.
- While dogfooding, collect friction, awkward prompts, missing affordances, and ideas for follow-up improvements.
- Record every still-open dogfooding finding as a small issue note under `./tmp/issues/`. Remove the note once the issue is fixed.
- If runtime behavior disagrees with the test, treat runtime as the source of truth and fix the test or implementation.

Passing tests alone are not sufficient.

### 4. Lock the scenario into regression coverage

After manual verification, preserve the exact user flow:

- Add or extend an `mcp-browser` test if component mount plus mocked fetches are enough.
- Add or extend E2E coverage if the scenario depends on real routing, websockets, persistence, daemon behavior, or page composition.

Do not stop at manual verification without preserving the scenario in automation.

## Browser Mode And Trace

`mcp-browser` is the default place for real browser regression tests inside this repo.

Use:

```bash
pnpm run test:browser
pnpm run test:browser:trace
```

- Failure traces are stored under `packages/mcp-server/tmp/vitest-traces`.
- Check traces before adding temporary debug code.
- Remove temporary debug overlays, logging, and instrumentation before finishing.

## MCP Development Mode

When developing this repo's MCP server, prefer the daemon-hosted HTTP MCP endpoint over direct `stdio`.

Use:

```bash
pnpm mcp:http:dev
pnpm mcp:inspect
pnpm mcp:debug:http
```

- This starts the local daemon in watch mode and exposes MCP at `http://127.0.0.1:3099/mcp`.
- Prefer connecting Codex or Claude Code to that URL during active MCP development so code changes only restart the daemon, not the whole MCP client integration.
- Use `stdio` MCP only for packaged-distribution checks or when specifically validating the standalone entrypoint behavior.
- Prefer the official MCP Inspector for first-pass debugging before switching to client-specific debugging.
- If request flow is unclear, restart with `MCP_HTTP_DEBUG=1 pnpm mcp:http:dev` and inspect the `[mcp-http:init]` / `[mcp-http]` logs.
- Keep the detailed checklist in `docs/mcp-debugging.md` in sync with actual repo workflow.

Recommended local client config during development:

- Codex: point `mcp_servers.whiteboard.url` to `http://127.0.0.1:3099/mcp`
- Claude Code: `claude mcp add --transport http whiteboard http://127.0.0.1:3099/mcp --scope local`

When changing MCP transport, routing, or tool registration:

- Add or update a nearest-layer automated test for `/mcp` behavior.
- Manually verify with a real MCP client against the running HTTP endpoint, not only via mocked unit tests.

Preferred MCP debugging order:

1. Reproduce with Inspector against `http://127.0.0.1:3099/mcp`
2. Verify `initialize` and `tools/list`
3. Enable `MCP_HTTP_DEBUG=1` if capability negotiation or request flow is unclear
4. Only then compare with Codex / Claude Code specific behavior

If the issue is client-specific:

- Capture the mismatch between Inspector and the real client before changing server behavior.
- Keep `docs/mcp-debugging.md` aligned with any new debugging workflow learned during the fix.

## Zod Schema Discipline

Use Zod as the **single source of truth** for every contract that crosses a process boundary (MCP tools, HTTP routes, persisted JSON, daemon registry, websocket messages).

Concrete rules when adding or editing an MCP tool:

- Declare each tool's `outputSchema` (and `inputSchema`) once. Tools are registered through `registerToolWithAnnotations`, which is generic over `O extends z.ZodTypeAny | undefined` and constrains the handler's return to `Promise<ToolHandlerReturn<O>>`. Never widen `outputSchema` to `unknown` or cast around the type binding to silence the compiler.
- Annotate the matching `tools/*.ts` `execute` return type as `Promise<z.infer<typeof xxxOutputSchema>>` (or import the inferred type from the schema). A separately-written TypeScript interface alongside a Zod schema is the recipe that shipped the `create_frame` `assignedMembers: number` vs `string[]` bug — use `z.infer<>` instead.
- When you add a new tool, extend `pnpm smoke:e2e` (`scripts/mcp-e2e-checkpoint.mjs`) to call it at least once. The MCP SDK validates `structuredContent` against `outputSchema` at runtime, so the smoke is the last line of defense against drift the type system can't see.
- When you fix a schema-vs-runtime drift, also commit the test or smoke step that would have caught it. Mutation-check the regression: revert the production fix, confirm `pnpm build` (compile-time guard) **or** `pnpm smoke:e2e` (runtime guard) fails, then restore.

The same discipline applies elsewhere where a schema and a runtime payload travel separately:

- Persisted JSON (`palette`, `manifestJson`, `frontiers`, etc.) → declare a Zod schema next to the parser, hydrate through `schema.parse(...)` instead of casting the JSON.
- Hono routes whose response shape is consumed by typed clients (`packages/mcp-server/src/app/...`) → declare the response schema once and let both server and client import `z.infer<typeof responseSchema>`.

If a contract is so loose that Zod would always be `z.unknown()` or `z.any()`, mark that intent in a comment so reviewers know it's deliberate, not an oversight.

## Tmp Workspace Discipline

Store temporary working artifacts under top-level `./tmp/`, grouped by type instead of dropping files in the root of `tmp/`.

- `tmp/issues/`: open dogfooding findings or follow-up issues discovered during manual verification
- `tmp/screenshots/`: screenshots captured while debugging or verifying UI behavior
- `tmp/scripts/`: throwaway helper scripts used only for local debugging or migration assistance
- `tmp/notes/`: temporary handoff notes, scratch writeups, or investigation summaries

When adding a new temporary artifact, put it in the right bucket immediately.
When an issue is resolved, delete its file from `tmp/issues/`.
When a temporary screenshot, script, or note is no longer useful, delete it instead of leaving stale debris behind.

## Completion Checklist

Before closing a change:

- Keep at least one nearest-layer automated test for the root cause.
- Complete manual verification of the real behavior.
- Preserve the verified user scenario in `mcp-browser` or E2E coverage.
- Run `pnpm test`.
- If the change can affect typing or packaging, also run:

```bash
pnpm --filter @kamiazya/whiteboard-mcp typecheck
pnpm build
```

## PR Title Rule

- Treat the pull request title as the future squash-merge commit message.
- Use a Conventional Commit title for normal PRs, for example `fix: ...`, `feat(scope): ...`, or `chore: ...`.
- Do not use tool prefixes such as `[codex] ...` in PR titles; CI rejects them.
- This matters because release-please reads the merged commit history to decide version bumps and changelog entries.
- Release Please PRs are also valid under the same rule, for example `chore(main): release vX.Y.Z` and `chore(main): release mcp-server vX.Y.Z`.

## Avoid

- Do not implement first and add tests later.
- Do not skip manual verification.
- Do not rely on jsdom alone for browser interaction bugs.
- Do not keep debug-only code in the final patch.
