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
- Use `web-browser` for `apps/web` tests that require real browser APIs not available in jsdom: IndexedDB, OPFS, `window.showOpenFilePicker`. File suffix: `.browser.test.tsx`.
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

`mcp-browser` is the default place for real browser regression tests in `packages/mcp-server`. Use `web-browser` for `apps/web` browser tests (IndexedDB, OPFS, etc.). `pnpm test:browser` runs both.

Use:

```bash
pnpm run test:browser        # mcp-browser + web-browser
pnpm run test:browser:trace  # same, with trace artifacts on failure
```

- Failure traces are stored under `<package>/tmp/vitest-traces`.
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
- Keep the detailed checklist in `docs/contributing/mcp-debugging.md` in sync with actual repo workflow.

The repo ships HTTP-mode overrides for both clients:

- `.claude/settings.json` → `http://127.0.0.1:3099/mcp`
- `.codex/config.toml` → `http://127.0.0.1:3099/mcp`

Both Claude Code (`.claude/settings.json`) and Codex
(`.codex/config.toml`) wire a `SessionStart` hook to
`packages/mcp-server/scripts/dev/ensure-http-dev-daemon.mjs`. The hook
probes port 3099 and, if nothing is listening, spawns `pnpm mcp:http:dev`
detached so the first MCP request can connect immediately. It is
idempotent — if our authenticated daemon is already up it exits
without touching anything; if a foreign service is on the port it
fails loudly so the developer can investigate. Output goes to
`tmp/logs/mcp-http-dev.log`. If hooks are disabled or the project is
not trusted yet, run `pnpm mcp:http:dev` manually in another terminal
before opening the repo.

With HTTP transport every client reload connects to the same long-lived
daemon, picking up source changes immediately and avoiding the stale-daemon
reuse that the old stdio + daemon-registry path was prone to.

stdio is reserved for packaged-distribution checks (validating
`@kamiazya/whiteboard-mcp` as it ships on npm). Day-to-day MCP development
inside this repo always goes through HTTP.

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
- Keep `docs/contributing/mcp-debugging.md` aligned with any new debugging workflow learned during the fix.

## Zod Schema Discipline

Use Zod as the **single source of truth** for every contract that crosses a process boundary (MCP tools, HTTP routes, persisted JSON, daemon registry, websocket messages).

Concrete rules when adding or editing an MCP tool:

- Declare each tool's `outputSchema` (and `inputSchema`) once. Tools are registered through `registerToolWithAnnotations`, which is generic over `O extends z.ZodTypeAny | undefined` and constrains the handler's return to `Promise<ToolHandlerReturn<O>>`. Never widen `outputSchema` to `unknown` or cast around the type binding to silence the compiler.
- Annotate the matching `tools/*.ts` `execute` return type as `Promise<z.infer<typeof xxxOutputSchema>>` (or import the inferred type from the schema). A separately-written TypeScript interface alongside a Zod schema is the recipe that shipped the `create_frame` `assignedMembers: number` vs `string[]` bug — use `z.infer<>` instead.
- When you add a new tool, extend `pnpm smoke:e2e` (`scripts/smoke/mcp-e2e-smoke.mjs`) to call it at least once. The MCP SDK validates `structuredContent` against `outputSchema` at runtime, so the smoke is the last line of defense against drift the type system can't see.
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

## Logging

Server-side code never calls `console.*` directly. Use the project logger:

```ts
import { getLogger } from './log.js'   // path varies by file depth

const log = getLogger('canvas-store')
log.warning('skipped corrupt row', { workspaceId, slug, err })
```

Why this exists:

- Levels follow the RFC 5424 names (`debug` / `info` / `notice` / `warning` /
  `error` / `critical` / `alert` / `emergency`) so the server can forward records
  unchanged through MCP `notifications/message` (see
  `src/server/mcp/logging.ts`).
- The default sink writes one JSON line per record to `stderr`. Stdio MCP
  parses JSON-RPC frames on stdout, so anything noisier on stdout would corrupt
  the stream — the linter (`noConsole` Biome rule scoped to
  `packages/mcp-server/src/server/**`) blocks new `console.*` from leaking in.
- `WHITEBOARD_LOG_LEVEL` (default `warning`) gates emission. `MCP_HTTP_DEBUG=1`
  lowers it to `info` automatically so HTTP-tracing logs survive without
  toggling two env vars.
- Clients can call MCP `logging/setLevel` to adjust their per-session view; the
  SDK handles the request once the `logging: {}` capability is registered.

Tests use `resetLoggerForTests({ level, sink })` to install a fake sink and
assert against structured records instead of spying on `console`.

### Redaction

The root pino instance in `log.ts` redacts a fixed list of field names —
top-level (`token`, `daemonToken`, `bootstrapToken`, `accessToken`,
`authorization`, `cookie`, `password`, `secret`, `apiKey`) and one level of
nesting under any key (`*.token`, `*.daemonToken`, …) — replacing the value
with `[redacted]` before the record reaches stderr, an MCP
`notifications/message` subscriber, or a test capture sink. This is what
stops a call site that carelessly logs a whole request/client/config object
(e.g. `log.error({ client }, 'request failed')`) from leaking the daemon
bearer token or an OAuth access token.

Adding a new secret-bearing field anywhere in the server means adding both
its top-level and its `*.<name>` path to `REDACTED_PATHS` in `log.ts` — pino
redaction does not infer field names, and `fast-redact` has no
arbitrary-depth wildcard, so a secret nested two or more levels deep under
an unlisted key is not caught. The safer habit is still to never log a
secret-bearing object wholesale in the first place; redaction is the net,
not the plan. Redaction also cannot help when a secret is interpolated
directly into a message *string* (e.g. `` log.info(`token=${token}`) ``)
rather than passed as a structured field — do not do that.

## Doc Screenshots

Images under `docs/assets/` that are produced from the running UI (canvas
list, storage tab, etc.) are regenerated by Vitest browser-mode tests
that render real components against deterministic mocked data and write
PNGs straight to their final paths.

```bash
pnpm --filter @kamiazya/whiteboard-web docs:snapshots
```

Each `*.docs-snapshot.test.tsx` under `apps/web/src/docs-snapshots/`
mounts a canonical apps/web component, waits for the post-fetch render
to settle, then calls `page.screenshot({ path: … })`. To add a new doc
image:

1. Drop a new `<name>.docs-snapshot.test.tsx` file under that directory.
2. Pin the system clock with `vi.setSystemTime(...)` so any "Xd ago"
   labels stay stable across regenerations.
3. Save to the canonical asset path with
   `resolveDocAssetPath('foo.png')` from `_helpers.ts`.
4. Run `pnpm --filter @kamiazya/whiteboard-web docs:snapshots` and commit
   the resulting PNG alongside the markdown change that references it.

The project is excluded from the regular `pnpm test` run because it
writes into the repo. Cross-platform font rendering means snapshots
generated on Linux CI will not be byte-identical to macOS / Windows
captures, so for now treat this as a developer-driven workflow:
regenerate locally, commit.

`pnpm --filter @kamiazya/whiteboard-web docs:snapshots:check` invokes the generator twice before running
`git diff --exit-code` because Vite's first run after a config change
can re-optimise dependencies and produce a one-off pixel drift; the
second run is the stable artifact. If a regeneration leaves
unexpected diffs in `docs/assets/`, it almost always means a real UI
change rather than residual jitter — re-run twice and inspect the
remaining diff.

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

## PR Visual Evidence

When the change has a user-visible effect (canvas rendering, UI surface, MCP tool result that depends on state), attach the verification screenshot to the PR body. Reviewers should be able to see the bug and the fix without having to clone and reproduce.

Workflow:

1. Capture screenshots while doing the manual verification step from the workflow above. Save them under `tmp/screenshots/` per the tmp-workspace rule.
2. Upload the captured screenshots to GitHub via the `gh image` extension (`drogers0/gh-image`):
   ```
   gh extension install drogers0/gh-image  # one-time setup
   gh image tmp/screenshots/before.png tmp/screenshots/after.png
   ```
   This prints `![file.png](https://github.com/user-attachments/...)` lines.
3. Paste the markdown into the PR body under a `## Visual repro` (or similarly named) section. Show before/after when the change is a fix; show one annotated capture when adding a new affordance.
4. Keep the actual screenshot file in `tmp/screenshots/` until the PR merges; remove it afterward to keep the dir lean (the GitHub upload is the durable copy).

Skip this rule for changes that are invisible to humans — purely backend, schema, internal helper, etc. — but lean toward attaching when in doubt; even a `pnpm test` output paste counts as visual evidence for `mcp-browser` regressions.

## Source Comment Discipline

Code lives a long time; comments live with the code. Only write comments that will still be useful five PRs from now.

Keep:

- The non-obvious **why** (a hidden constraint, an invariant, a workaround for a specific upstream bug, behavior that would surprise a reader).
- A pointer to a durable spec, RFC, or vendor doc when behavior follows it.

Drop:

- References to the PR / issue / dogfood pass that introduced or surfaced the change ("Surfaced during PR #35 dogfood", "see tmp/issues/...md item #N", "the create_frame bug...").
- Pointers to `tmp/notes/`, `tmp/issues/`, or `tmp/screenshots/` files. The `tmp/` directory is short-lived and the linked file may already be gone.
- Personal narrative ("we found this when...") and TODO-style chronology.

Process context belongs in the commit message, the PR body, and `git log`/`git blame`. The source file is for the long-term reader who has neither.

If a comment looks valuable when written but you'd be embarrassed to read it three years from now, rewrite it as an enduring rationale or delete it.

## Avoid

- Do not implement first and add tests later.
- Do not skip manual verification.
- Do not rely on jsdom alone for browser interaction bugs.
- Do not keep debug-only code in the final patch.
