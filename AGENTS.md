# Project Instructions

Use this repo's standard development loop for every feature, bug fix, or refactor:

1. Start with the smallest failing test at the nearest layer.
2. Make the smallest patch that turns it green.
3. Manually verify the real behavior in a running app or browser.
4. Lock the verified user flow into `canvas-viewer-browser`/`web-browser` or a broader E2E test when browser-mode is not enough.

## Test Layer Selection

- Use `mcp-node` for pure functions, stores, routes, server behavior, and persistence logic in `packages/mcp-server`.
- Use `canvas-viewer-node` / `canvas-viewer-jsdom` for `packages/canvas-viewer` parsing, hooks, and components where browser layout and pointer behavior are not the core risk; use `canvas-viewer-browser` when they are.
- Use the `apps/web` jsdom project (`apps/web/vitest.config.ts`) for React components and hooks when browser layout and pointer behavior are not the core risk.
- Use `web-browser` for `apps/web` tests that require real browser APIs not available in jsdom: IndexedDB, OPFS, `window.showOpenFilePicker`. File suffix: `.browser.test.tsx`.
- Promote to E2E when the bug depends on real routes, server composition, websocket timing, persistence order, or multi-step page flows.

Do not jump to broad E2E first if a smaller failing test can isolate the bug.

### Property-Based / Model-Based Testing (PBT)

Prefer a property or model-based test (fast-check; shared wrappers in
`packages/mcp-server/src/shared/test-utils/fast-check.ts` and
`apps/web/src/test-utils/fast-check.ts`) over an example-only test when the change touches:

- a parser/serializer (round-trip: `parse(serialize(x))` equals `x` or a well-defined normalization of `x`)
- a state machine or store with time/TTL/revocation semantics (model-based: generate a random
  command sequence, check invariants after each step)
- a concurrent store (convergence: N concurrent operations settle on one agreed-upon result)
- a CRDT or other mergeable structure (idempotence, commutativity, convergence under any merge order)
- rounding, normalization, or other value transforms with an algebraic invariant

When a property models a SURFACE that keeps growing — the editor's command set, its gesture
events, its keyboard catalog, its editing verbs — pin that surface with a coverage ledger rather
than trusting whoever adds the next feature to remember this file exists. A ledger is a
`satisfies Record<TheUnion, SurfaceCoverage>` map guarded in four directions, two by the type
system and two at runtime by the shared helper in
`apps/web/src/test-utils/coverage-ledger.ts` — never a per-file re-implementation.

**`.claude/rules/coverage-ledger.md` is the convention**: when a surface earns one and (the half
that matters more) when it does not, the declare -> model -> pin order, the source-scan variant
for a surface with no union behind it, and the traps. Worked examples are
`editor-state.property.test.ts` (three union ledgers), `editor-verbs.property.test.ts` (one), and
`editor-state-surface.test.ts` (the source scan).

Prefer example/browser tests for UI wiring, one-off integrations, and anything without a clean
invariant to state. When a property finds a real bug, pin the shrunk counterexample as an example
test before fixing the implementation — the example is the regression guard, the property is the
generator that found it. Mutation-check every NEW property before trusting it: temporarily revert
the rule/fix it pins and confirm the property goes red. A generator too sparse to reach the
interesting arrangements (boxes that rarely overlap, sequences that rarely collide) passes
vacuously — the mutation check is what catches a property that asserts nothing, and the fix is a
denser generator, not more runs. Never pin a fast-check seed to make a flaky property pass; treat repeat
failures under load as a signal to reduce `numRuns`, not to fix the RNG. Put arbitraries shared
across test files in the owning package's `test-utils`, not duplicated per file.

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

Dev sessions reach the daemon through the stdio proxy
`packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs`:

- **Claude Code**: register it once per checkout at LOCAL scope (machine-
  private `~/.claude.json`), which shadows the published `npx` definition
  in `.mcp.json` (precedence: local > project). `.mcp.json` itself is the
  PUBLIC plugin/team surface and stays pointed at the published package —
  do not repoint it at dev tooling. Note `settings.json` has no
  `mcpServers` field in its schema; a definition there is silently ignored.

  ```bash
  claude mcp add --scope local --transport stdio whiteboard --     node "$(git rev-parse --show-toplevel)/packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs"
  ```

- **Codex**: `.codex/config.toml` registers the same proxy as
  `whiteboard_dev` (repo-tracked; it already disables the plugin-provided
  published server).

The clients register the proxy as a stdio server rather than the HTTP URL
directly: an MCP client attempts one HTTP connection at session start and
never retries, so it can lose the race against the SessionStart hook
spawning the daemon, and a watch restart mid-session strands the
connection the same way. The stdio spawn always succeeds; the proxy runs
the ensure hook, waits for readiness, and retries each request across
watch restarts. This is sound because `/mcp` is stateless per request —
one stdin line becomes one authenticated POST, with no protocol session
to lose. Server-initiated notifications do not traverse the proxy;
reload the client session to pick up a changed tool list.

Both Claude Code (`.claude/settings.json`) and Codex
(`.codex/config.toml`) wire a `SessionStart` hook to
`packages/mcp-server/scripts/dev/ensure-http-dev-daemon.mjs`. The hook
probes this checkout's derived dev port (3099 on the main checkout,
a deterministic per-worktree port otherwise — see
`docs/contributing/development.md`'s ".dev-data" section) and, if
nothing is listening, spawns `pnpm mcp:http:dev` detached so the first
MCP request can connect immediately. It is idempotent — if our
authenticated daemon is already up **and its identity marker matches
this worktree** it exits without touching anything; if a foreign
service, or a different worktree's daemon that hash-collided on the
same port, is on the port it fails loudly so the developer can
investigate. Output goes to `tmp/logs/mcp-http-dev.log`. If hooks are
disabled or the project is not trusted yet, run `pnpm mcp:http:dev`
manually in another terminal before opening the repo.

The probe-decide-spawn sequence is mutually exclusive across
processes: two hooks starting close together (a new editor session
plus a `new-worktree.mjs` run, say) acquire an exclusive, atomically-
created lock file (`<dataDir>/dev-daemon-spawn.lock`, alongside the
`dev-daemon.json` identity marker — per-worktree exactly like the
derived port) before probing the port, so only one of them ever
spawns. The loser doesn't exit or spawn a competitor — it waits for
the winner's daemon to become reachable and exits 0 once it answers,
because the developer's session just needs a working daemon regardless
of who started it. A lock abandoned by a crashed hook self-heals: it
is stolen once its recorded pid is dead, or once it exceeds
`WHITEBOARD_DEV_SPAWN_LOCK_STALE_MS` (default 45s).

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

When the change has a user-visible effect (canvas rendering, UI surface, MCP tool result that depends on state), attach the verification screenshot to the PR body. Reviewers should be able to see the bug and the fix without having to clone and reproduce.

Workflow:

1. Capture screenshots while doing the manual verification step from the workflow above. Save them under `tmp/screenshots/` per the tmp-workspace rule. For a FIX that means two: the same case rendered by the code before and after.
2. Compose the two into one figure:
   ```
   node .claude/scripts/compose-figure.mjs \
     --before tmp/screenshots/before.png --after tmp/screenshots/after.png \
     --out tmp/screenshots/figure.png \
     [--before-label "…"] [--after-label "…"] [--ring x1,y1,x2,y2]
   ```
   It refuses two panels that are the same picture — which is what every failed attempt at producing a real "before" looks like — and prints both pixel signatures for the body. A new affordance has nothing to compare against; one capture of it is the whole figure, and this step is skipped.
3. Upload the figure to GitHub via the `gh image` extension (`drogers0/gh-image`):
   ```
   gh extension install drogers0/gh-image  # one-time setup
   gh image tmp/screenshots/figure.png
   ```
   This prints an `![figure.png](https://github.com/user-attachments/...)` line.
4. Paste the markdown into the PR body under a `## Visual repro` (or similarly named) section, with one sentence naming what to look at — and say what the figure CANNOT show, when something about it is staged (a case only reachable behind a flag, a state supplied through a seam rather than by its real producer).
5. Keep the PNGs in `tmp/screenshots/` until the PR merges; remove them afterward to keep the dir lean (the GitHub upload is the durable copy).

Skip this rule for changes that are invisible to humans — purely backend, schema, internal helper, etc. — but lean toward attaching when in doubt.

**Say so when you skip**, in the body: `Visual evidence: none — <reason>`. A PreToolUse hook blocks `gh pr create` when the diff touches a surface a human looks at and the body carries neither a figure nor that line, so the skip is a decision on the record rather than an omission — and the reason is required, because a bare "none" is the same omission with a sentence in front of it. Everything that is real evidence but not a picture goes there too: a `pnpm test` output paste for a `canvas-viewer-browser`/`web-browser` regression is a perfectly good reason, and reads as one.

The hook exists because this section was prose alone for a long time and the practice decayed into a `## Visual repro` heading over an after-only capture — which satisfies a reader skimming for the section while showing a reviewer nothing.

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
