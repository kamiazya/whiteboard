---
paths:
  - "packages/server-core/**"
---

# server-core — /api/v1 Hono routes + MCP tool definitions, createServer(deps) factory

## What belongs here

- The `createServer(deps)` factory: assembles a `Hono` app from the
  store/sync ports supplied via `ServerDeps`, and returns `{ app }`.
- `/api/v1` Hono route definitions (future slices).
- MCP tool definitions and MCP resource definitions (future slices) —
  their `inputSchema`/`outputSchema` and `execute` handlers, wired to the
  injected deps.
- Response-schema declarations shared with typed clients (declared once as
  Zod, imported via `z.infer` on both sides).

## What does NOT belong here

- Store/sync **implementations** (local libSQL/fs, IndexedDB, Durable
  Objects/D1/R2) — those live in composition roots (`mcp-server`,
  `apps/web`, future Cloudflare root). This package receives them through
  the factory as `ServerDeps`.
- CLI, stdio transport, daemon startup/registry logic, resvg, or any
  process lifecycle — `mcp-server` owns that.
- InversifyJS or any DI container wiring — composition roots only.
- Scene graph, layout, rendering internals — `canvas-render`.
- Tree ops, alias/index derivation — `loro-adapter`.

## Dependency rules

- Runtime dependencies: `model`, `codec`, `canvas-render`,
  `ports`, `facet-engine`, `loro-adapter`, `hono`, and `zod` (via `catalog:`
  or `workspace:*`).
- Forbidden imports: `node:*`, DOM globals (`document`/`window`/`navigator`),
  `inversify`.
- Enforced by `tools/arch-lint` (`arch-lint-node` vitest project) and the
  dependency-direction check against `architecture-map.ts`.

## Conventions

- Tools and routes receive their dependencies from the `createServer`
  factory (via `ServerDeps`), never through direct module imports of a
  store/sync implementation. The shared layer only knows the port
  contracts from `ports`.
- Every contract crossing a process boundary (MCP tool I/O, HTTP response
  shape) is declared once as a Zod schema and consumed via `z.infer` — no
  hand-written interface next to a schema.

## Tests

- Vitest project: `server-core-node` (registered in root `vitest.config.ts`).
- Smoke: `createServer` returns an app whose `fetch` is callable.
- **Every tool is fuzzed from its own input schema**
  (`tools/tool-inputs.fuzz.property.test.ts`): `arbitraryForSchema` over
  `tool.inputSchema` for each entry of `createServer(deps).tools`, run
  against a seeded in-memory workspace (a spatial document with two text
  nodes, a group, an edge and a comment; a markdown document with
  frontmatter and a body; one saved version). Each call must ANSWER or
  REFUSE — a domain error naming what was wrong — never crash (a
  `TypeError` / `RangeError` / `ReferenceError`, a non-Error thrown, or a
  message in a crash's vocabulary), and what it answers must parse under
  its own `outputSchema`, which is what the MCP SDK checks at runtime. Ids
  are drawn from the seeded workspace at real weight (matched by schema
  def, since `.describe()` clones the object), and three tools get a
  per-tool fix-up over a share of draws for what one field cannot know
  about its siblings (a facet payload for the target the write names, a
  passage edit's `assumed` equal to what the passage says, one canvas op
  at a time, each fitted to what the canvas holds). A batch tool's op union
  is ALSO driven one arm at a time, because a wide union passes on the arms
  a random batch happens to reach — measured: 100 batches of
  `wb_canvas_edit` answered with 7 of its 13 op kinds (16 since the LINE ops
  — `line.add`, `line.patch`, `line.remove`, which is what lets anything but
  the editor author ink, ADR-0038 decision 2), and `node.patch`,
  `node.splice`, `edge.remove`, `comment.resolve` and `region.set` never
  reached the answering path. `OP_REACH` is the ledger over those arms in
  the repo's sense (`coverage-ledger.md`): read off the schema in both
  directions, `answers` checked against the run, and a `refused-only:`
  entry says why the seeding cannot reach an arm and is checked to still be
  true. **A new arm needs the seeded workspace to be able to REACH it**, not
  only an entry: `line.patch` and `line.remove` were declared `answers` and
  refused every draw for want of an id, because the fixture carried no ink.
  A board with one line, plus the same per-arm steer the edge ops get, is
  what turned the claim true — the ledger reporting "claimed to answer,
  never did" is what caught it, and it reads like a broken op rather than an
  empty fixture. The `afterAll` also fails when a whole tool never answered, so a
  tool added to the record that the seeding cannot reach is visible rather
  than green; `FUZZ_TALLY=1` prints each tool's tally, its refusal reasons
  and the shapes it answered with. The refusing doubles this lane does not
  replace (`unused*`) count as `environment`, never as a pass.
- **Every `/api/v1` route is fuzzed the same way**
  (`create-server.routes.fuzz.property.test.ts`), over the same seeded
  workspace (`test-utils/seeded-workspace.ts`, shared with the tool lane;
  both documents carry a display name and the note's prose mentions the
  board, so linkify has a mention to find). A route may answer (2xx) or
  refuse a request it understood (4xx with a JSON body naming why) and
  nothing else: a 5xx is a stack trace where a reason should be. Bodies are
  drawn from the route's own schema (ids and paths following the seed), as
  arbitrary JSON, and as text that is not JSON, at real weight, because the
  parse that answers the last two is a branch the schema-drawn body never
  reaches. A schema-drawn body on the seeded workspace must never come back
  `{ error: 'invalid input' }` — the route re-parses `{ params, ...body }`
  with that schema, so that refusal is the route and the schema disagreeing
  about what the schema says; a 400 with another reason is the route's
  call. The `afterAll` fails when a route never answered, and a row count
  pins one row per route schema so a route added without one is visible.
  Its first catch: `POST .../documents` with `kind: 'markdown'` and a body
  OKF cannot parse (an empty string, prose with no frontmatter) answered
  500 — `OkfParseError` escaped `mapDocumentError`, which now maps it to
  400 with the stage in the message.
  Every 2xx it gets is also parsed with the route's OUTPUT schema (the one
  a typed client reads with): the handler is typed, but nothing parses on
  the way out, so a field added to what a route emits and not to its
  schema — or the reverse — is drift only a reader would find.

## Render style and canvas-target facets (ADR-0030)

- `wb_scene_render` and the daemon's export routes take `style`, parsed by
  `spatialRenderStyleSchema` from `canvas-render` — `'clean'`, `'document'`,
  or a registered theme id. The tool DEFAULTS it to `'clean'` in the schema
  (so `z.infer` makes it required on `execute`, and a test calling the tool
  directly passes it), the export contracts leave it optional and the layout
  supplies the same default. Absent never means "the document's theme": an
  agent reading SVG pays for a theme's jitter or glow only when it asks.
- `composeCanvasScene` forwards `style` and nothing else theme-shaped. The
  digest goes through the same composer with no style, which is what keeps
  `wb_canvas_snapshot`'s layout analysis from moving because a theme did.
- `wb_facet_set`'s `target: 'canvas'` writes `x-whiteboard.facets` on a
  spatial document with the web editor's canonical emptiness (an empty
  bucket disappears, and an empty envelope with it). It is an enum of two,
  not three: `nodeId` already says "a node", and `nodeId` beside
  `target: 'canvas'` is refused at execute time
  (`NodeAndCanvasTargetError`) rather than by a schema `.refine`, because a
  refined schema loses the `.shape` MCP registration reads.
- A theme id in a clean render is asserted by the glow's filter id
  (`wb-glow`), never by the word `filter`: a drop shadow is a filter too,
  and the e2e smoke failed on exactly that substring once.

## Common mistakes (append as review finds them)

- Importing a store/sync implementation directly instead of taking it via
  `ServerDeps`.
- Importing `node:*` or DOM globals in this shared-layer package.
- Adding a hand-written interface next to a Zod schema instead of `z.infer`.

## Tool surface criteria (ADR-0031)

A tool definition here is read by a model on every turn, so its cost and its
clarity are measured, not argued. Before changing a tool's name, description,
schema or existence, load the `mcp-tool-surface` skill (the procedure) and
read `docs/contributing/adr/0031-tool-surface-criteria.md`
— the numbered criteria, and which instrument checks each — and expect
`packages/mcp-server/src/server/mcp/tool-surface-quality.test.ts` to fail
until its pinned row is updated with a line saying why it moved. A retirement
or a consolidation also runs the LLM-driven lane
(`pnpm --filter @kamiazya/whiteboard-mcp eval:tool-surface`) before and after.

Two of the criteria are debt this package owns today: every input parameter
carries a `.describe()` (299 do not), and a tool is registered with its Zod
OBJECT rather than its `.shape`, so `.strict()` reaches the boundary and a
typo'd key is refused rather than stripped (15 tools strip).
