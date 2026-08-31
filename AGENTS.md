# Project Instructions

Use this repo's standard development loop for every feature, bug fix, or refactor:

1. Start with the smallest failing test at the nearest layer.
2. Make the smallest patch that turns it green.
3. Manually verify the real behavior in a running app or browser.
4. Lock the verified user flow into `canvas-viewer-browser`/`web-browser` or a broader E2E test when browser-mode is not enough.

## Test Layer Selection

Start with the smallest failing test at the **nearest** layer, and do not jump to broad E2E when a
smaller failing test can isolate the bug. Reach for a property or model-based test (fast-check)
over an example-only one when the change touches a parser/serializer, a state machine with
time/TTL/revocation semantics, a concurrent store, a CRDT or other mergeable structure, or a
rounding/normalization transform with an algebraic invariant. Prefer example and browser tests for
UI wiring, one-off integrations, and anything with no clean invariant to state.

Everything that follows from that choice is the **`test-layer-selection` skill**: which project
serves which layer and the command for each, the per-layer `numRuns` budget, and the property
disciplines — mutation-check every new property, answer a vacuous one with a denser generator
rather than more runs, never pin a seed, and never build an oracle out of the code it is judging.
Coverage ledgers are `.claude/rules/coverage-ledger.md`, which is path-scoped and loads itself.

## Required Workflow

### 1. Write the red test first

- Reproduce the bug or target behavior before changing production code.
- Keep the first failing case as small and local as possible.

### 2. Turn it green locally

Run the narrowest project first:

```bash
pnpm test --project mcp-node
pnpm test --project canvas-viewer-jsdom
pnpm test --project canvas-viewer-browser
```

After the targeted test passes, run the broader suite that covers the touched area.

### 3. Manually verify the real behavior

- For UI work, open the real screen and confirm the behavior directly.
- Prefer Chrome DevTools MCP or Playwright MCP when available to inspect DOM, console, network, and visible behavior.
- If the changed flow is represented by a project skill under `./skills/*`, read the relevant `SKILL.md` and dogfood the real MCP/skill flow instead of verifying only through mocks.
- While dogfooding, collect friction, awkward prompts, missing affordances, and ideas for follow-up improvements.
- Record every still-open dogfooding finding as a whiteboard document issue (see the `ticketing` skill). When it is fixed, change it to `type: note` with a `RESOLVED — ` name and say what fixed it — do not delete it. What the document accumulated is the measurements, and those are what stop it being investigated again.
- If runtime behavior disagrees with the test, treat runtime as the source of truth and fix the test or implementation.

Passing tests alone are not sufficient.

### 4. Lock the scenario into regression coverage

After manual verification, preserve the exact user flow:

- Add or extend a `canvas-viewer-browser` or `web-browser` test if component mount plus mocked fetches are enough.
- Add or extend E2E coverage if the scenario depends on real routing, websockets, persistence, daemon behavior, or page composition.

Do not stop at manual verification without preserving the scenario in automation.

## Browser Mode And Trace

`canvas-viewer-browser` is the default place for real browser regression tests in `packages/canvas-viewer`. Use `web-browser` for `apps/web` browser tests (IndexedDB, OPFS, etc.). `pnpm test:browser` runs both.

Use:

```bash
pnpm run test:browser        # canvas-viewer-browser + web-browser
pnpm run test:browser:trace  # same, with trace artifacts on failure
```

- Failure traces are stored under `<package>/tmp/vitest-traces`.
- Check traces before adding temporary debug code.
- **Keep a browser test's `describe` + `it` titles under 155 characters
  combined** (characters, not UTF-8 bytes: vitest replaces every
  non-alphanumeric character with one ASCII `-` before the name reaches the
  filesystem, so `導線` costs two, not six). vitest copies the trace into `.vitest-attachments/` under a name
  flattened from its path, and past the filesystem's 255-byte limit that copy
  throws `ENAMETOOLONG` during teardown — so vitest abandons the REST OF THE
  FILE. Measured: one forced failure with a 194-char title reported
  `1 failed | 2 passed (6)`, the same failure with a 58-char title reported
  `1 failed | 5 passed (6)`. Three tests silently did not run, and the smaller
  total reads like good news. `apps/web/src/browser-test-name-length.test.ts`
  enforces the budget.
- Remove temporary debug overlays, logging, and instrumentation before finishing.

## MCP Development Mode

Develop this repo's MCP server against the **daemon-hosted HTTP endpoint**, not `stdio`:
`pnpm mcp:http:dev` starts the local daemon in watch mode at `http://127.0.0.1:3099/mcp`, so a
code change restarts the daemon rather than the whole client integration. `stdio` is reserved for
packaged-distribution checks — validating `@kamiazya/whiteboard-mcp` as it ships. Debug in this
order: MCP Inspector against that URL (`pnpm mcp:inspect`), then `initialize` and `tools/list`,
then `MCP_HTTP_DEBUG=1` if capability negotiation or request flow is unclear, and only then
compare against a specific client.

When changing transport, routing, or tool registration, add or update a nearest-layer automated
test for `/mcp` behaviour and verify against the running endpoint with a real client, not only
mocked unit tests.

Everything else — how each client registers the stdio proxy, the SessionStart hook that ensures
the daemon, its per-worktree port and spawn lock, and the failure modes — is
`docs/contributing/mcp-debugging.md` and `docs/contributing/development.md`, which carry it in
more detail than a summary here could. Keep those in sync with the real workflow.

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

- `tmp/screenshots/`: screenshots captured while debugging or verifying UI behavior
- `tmp/scripts/`: throwaway helper scripts used only for local debugging or migration assistance
- `tmp/notes/`: temporary handoff notes, scratch writeups, or investigation summaries

Issues and follow-up findings go into whiteboard canvases, not `tmp/` (see the
`ticketing` skill). `tmp/` is for short-lived artifacts only.

When adding a new temporary artifact, put it in the right bucket immediately.
When a temporary screenshot, script, or note is no longer useful, delete it instead of leaving stale debris behind.

## Logging

Server-side code never calls `console.*` directly. Use the project logger:

```ts
import { getLogger } from './log.js'   // path varies by file depth

const log = getLogger('canvas-store')
log.warning({ workspaceId, documentId, err }, 'skipped corrupt row')
```

**Fields first, message second.** This is pino's signature, and getting it
round the wrong way is silent: `log.warning('msg', { … })` matches the
printf overload, where the object is an interpolation argument for a message
with no placeholder, so it is dropped and the record ships with no fields at
all. Nothing fails — not the types (`...args` is `any[]`), not a test that
only checks the message. Measured on a real call site: `{"level":"warning",
"scope":"…","msg":"…"}` with the `dataDir` and `err` simply gone.

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

Images under `docs/assets/` that come from the running UI are regenerated by vitest browser-mode
tests that render real components against mocked data and write PNGs to their final paths:
`pnpm --filter @kamiazya/whiteboard-web docs:snapshots`. Adding one, the clock-pinning that keeps
"Xd ago" labels stable, and why the check runs twice are the `docs-sync` skill.

## Completion Checklist

Before closing a change:

- Keep at least one nearest-layer automated test for the root cause.
- Complete manual verification of the real behavior.
- Preserve the verified user scenario in `canvas-viewer-browser`/`web-browser` or E2E coverage.
- Run `pnpm test`.
- Run `pnpm check:local`, which is every gate CI's `check` job runs plus `pnpm knip`.
  It is derived from `.github/workflows/ci.yml` rather than remembered:
  `local-gate-command.test.ts` fails when the job gains a step the script does not
  run, because a local pass that reports green while CI would fail is worse than no
  local pass — it gets trusted. A remembered five-command list had already drifted
  three steps behind the job.
- Resolve any `pnpm knip` finding one of three ways before closing: delete the dead code, drop the unused `export`, or register it in `knip.jsonc` as an intentional public surface with a reason comment.
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

A change with a user-visible effect ships its verification figure in the PR body, so a reviewer
sees the bug and the fix without cloning. For a FIX that means two panels — the same case before
and after — not one capture of the result. **Say so when you skip**: `Visual evidence: none —
<reason>` in the body, with a real reason; a PreToolUse hook blocks `gh pr create` otherwise, so
the skip is a decision on the record rather than an omission. Other real evidence goes there too
— a `pnpm test` paste for a browser-mode regression reads as a reason.

How to produce the figure — rendering both versions through the real pipeline, composing them
with `compose-figure.mjs` (which refuses two identical panels), uploading it, and the traps that
have each produced a misleading figure — is the `visual-evidence` skill.

## Source Comment Discipline

Code lives a long time; comments live with the code. Only write comments that will still be useful five PRs from now.

Keep:

- The non-obvious **why** (a hidden constraint, an invariant, a workaround for a specific upstream bug, behavior that would surprise a reader).
- A pointer to a durable spec, RFC, or vendor doc when behavior follows it.
- A `ponytail:` marker on a deliberate shortcut, naming its ceiling and upgrade path (`ponytail: global lock, per-account locks if throughput matters`). Naming the ceiling is enduring rationale and belongs here; a bare "TODO: fix later" is chronology and belongs in the Drop list below.

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
