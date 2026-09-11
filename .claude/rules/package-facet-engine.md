---
paths:
  - "packages/facet-engine/**"
---

# facet-engine — the facet engine (ADR-0013)

## What belongs here

- `defineFacet` / `definePlugin` factories and the `FacetDefinition` /
  `FacetPlugin` shapes (definition-time grammar checks throw — programmer
  error, not data).
- `createFacetRegistry`: per-plugin-id collision check, `targetsOf`,
  write-side validation (`validateFacetWrite`, ADR-0013 decision 6) and
  read-side compat resolution (`resolveFacetPayload`, decision 7 — stepwise
  chain, drop-not-fail, newer-than-registered preserved). `facetForm(key)`
  answers the derived editor form, and lives here rather than at each
  vessel for the reason every resolution does: a vessel that derives it
  itself can derive it DIFFERENTLY, so one surface would draw the picker a
  plugin declared and the next its schema's own fields, from one
  registration. Two vessels ask now — `DerivedFacetForm`, and the settings
  row for a facet whose EFFECTIVE value only the app can resolve.
- The bundled `visual` plugin and its facet schemas, plus resolvers
  (`resolveCanvasEdgeStyle`, `resolveNodeShape`: facet first, legacy
  fallback where one exists). Both are adopted by canvas-render's layout
  defaults and the editor — user-reachable, no longer foundation-only.
- The contribution RESOLUTION layer (`contributions.ts`): the closed
  `ContributionPoint` set, and `resolveFacetContributions` answering "what
  facet UI does this point carry" as namespace groups derived mechanically
  from facet `targets` — ordered by plugin ID (never `displayName`, which
  may be reworded/localized), headed by `displayName`. Ownership is
  two-level: the POINT (core surface) owns the point set, the namespace
  containers, their order and caps; a PLUGIN owns only the inside of its
  own container. The VESSEL half (actual React rendering, widget lookup by
  facet key) lives in each surface's composition root — today
  `apps/web/src/components/spatial-editor/facet-widgets/`, guarded by
  `facet-wiring-guard.test.ts` so point-owning surfaces never name a
  domain.

- The editor-ladder TIER 1 derivation (`form.ts`): `deriveFacetForm` turns
  a facet's own schema into a form spec in a CLOSED control vocabulary
  (`text`/`number`/`toggle`/`choice`, plus a discriminated-union variants
  form). A schema outside that vocabulary answers `unsupported` — the
  honest signal that the facet wants a hand-written widget (tier 2), never
  a half-rendered payload. Rendering is the vessel's job, exactly as with
  contributions: `apps/web`'s `FacetFormPanel` is today's vessel, and
  writes there go back through `validateFacetWrite`, so a panel can never
  store what `wb_facet_set` would refuse.

- TIER 2, in the same module: an optional `editor` spec on a facet
  definition, declaring per-field widget/label/quick-band from a CLOSED
  vocabulary (`text`/`number`/`toggle`/`choice`/`segmented`), or a
  facet-level `picker` writing whole payloads. Options carry a `FacetGlyph`
  — closed in FORM (a plugin cannot add an arm), open in CONTENT: a core
  silhouette, a character, registered icon geometry, or registered geometry
  inked the way a registered THEME inks it. A row also declares its
  `layout` — `cards` (picture over word, for a short vocabulary whose names
  carry meaning) or `chips` (picture alone, for a palette) — declared
  rather than derived from the option COUNT, since the count does not know
  whether the name is worth screen space. `deriveFacetForm(schema, editor)`
  merges it over the derived form; `assertEditorSpecFits` rejects at definition time a spec
  naming a field the schema does not declare, or one on a schema with no
  derivable form. A segmented option's `value: null` means the facet's
  ABSENCE — some defaults are unrepresentable as a stored value (a rect
  node stores no shape facet), and a picker with no way to say that
  cannot express them. The bundled `visual.shape` declares its band this
  way and ships NO hand-written widget, which is how the mechanism is
  proved by the plugin that ships with the engine.

  `visual.text/v0` is the stronger proof, and the shape to copy for a new
  node property: it was added to `visual.ts` alone, and reached the
  context menu — row, segmented control, write path, clear — with zero
  lines changed in `apps/web`. If a new facet needs a vessel edit to be
  usable, the editor spec is the thing to extend, not the vessel.

- `testing/` (the `./testing` subpath; fast-check and model as dev
  dependencies): the property-test generators over facets.
  `facetsArbitrary(registry, target)` draws each facet the registry holds
  for a target from its own Zod schema — through model's
  `arbitraryForSchema` (`@kamiazya/whiteboard-model/test-utils`, where the
  zod-to-fast-check walk lives so every package above model reaches it) —
  an `assetRefs` field drawing the registered ids, every payload filtered
  by `validateFacetWrite` itself. Not a per-consumer helper and not in a
  test folder, because the question is the engine's: what CAN this build
  write for a facet it was told about at distribution time? A consumer that
  folds over a node's facets — a layout, an exporter, an editor's drag
  layer — is property-testable against the registry rather than against a
  list of facet names, which is the difference between a property that
  covers the facet added next month and one that silently does not. Two
  disciplines keep it honest, each with a test: a construct the walk has no
  generator for THROWS naming the path, never yields nothing; and a filter
  nothing drawn would pass — a refinement, an asset kind with nothing
  registered — throws at construction with the first rejection, because
  fast-check's `filter` otherwise retries forever, synchronously, with no
  timeout to catch it (measured: the first draft keyed an override on the
  wrong path and the suite hung at collection). `canvas-render` and
  `apps/web` are the consumers; each keeps one guard that every facet of
  the BUNDLED registry is actually drawn, since this package cannot see the
  plugin. The form-derived sampler this replaced (`facetPayloadSamples`)
  was a finite list with no shrinking and nothing `deriveFacetForm` could
  not express. The walk itself started here and moved to model the day
  model's own generators were derived from their schemas: a dev dependency
  on model is allowed in this direction, and the reverse is not.

- The THEME TOKEN CONTRACT and plugin ASSETS (ADR-0030 decision 3,
  `theme-tokens.ts` + the registry): `themeTokensSchema` is the one shape a
  registered theme has — ink, an optional font FAMILY name, an optional
  glow, BOTH mode palettes (six-digit hex only; resvg parses no oklch), and
  `defaults` for what is drawn. A plugin registers `assets.themes` /
  `assets.icons` by bare name and the registry composes `<plugin>.<name>`,
  exactly as silhouettes are namespaced; `assetIds` / `themeAsset` /
  `iconAsset` answer them. A facet declares `assetRefs: { field: kind }`
  and `validateFacetWrite` then refuses a payload naming an asset no plugin
  registered (the message lists what is registered) — while
  `resolveFacetPayload` never checks, because a stored id another
  deployment registered is data and the renderer degrades on it. The
  contract lives HERE rather than in canvas-render so it is a prefix of
  ADR-0013 decision 8: when views and slots land, neither the type nor any
  asset moves.

## What does NOT belong here

- Facet KEY grammar and the `facets` bucket schemas — those are model's
  (`extensionFacetsSchema`); this package constructs keys and a test
  cross-checks them against model's grammar.
- Storage, rendering, transport, UI vessels (React widgets — those live in
  the composition roots), Inversify.

## Dependency rules

- Runtime deps: `@kamiazya/whiteboard-model` (workspace), `zod` (catalog).
  Forbidden: `node:*`, DOM globals, `inversify`, `loro-crdt` — enforced by
  `tools/arch-lint` like every shared-layer package.

## Conventions

- Payload types are `z.infer`-derived. Definition/registry shapes
  (`FacetDefinition`, `FacetPlugin`, results) are the documented exception:
  they CARRY zod schemas and migration functions, which `z.infer` cannot
  express.
- `compat` maps an older version tag to its RETAINED schema plus a pure
  migration to the NEXT version only; the registry composes the chain. Never
  add a cross-version converter that skips a step.
- The bundled plugin is ordinary (no privileged namespace, no special
  ordering); anything that would special-case it belongs nowhere.
- `displayName` is required and human-facing only — UI containers show it;
  the id stays machine-only (key grammar, storage, ordering).
- Adding a `ContributionPoint` is a core increment, like adding a widget
  kind: a plugin can neither mint a point nor place itself outside its
  container.
- Result types are discriminated unions (`resolved`/`dropped`/`preserved`/
  `passthrough`, `ok` true/false) — never sentinel nulls.

## Tests

- Vitest project: `facet-engine-node` (registered in root `vitest.config.ts`).
- Compat-chain behavior is property-tested with injective migrations so the
  exact output is asserted, and the property is mutation-checked (skipping
  the final chain step must go red).
- Asset registration is property-tested (`assets.property.test.ts`): every
  listed id resolves, `(plugin, name)` → id is injective, and
  `validateFacetWrite` accepts an id iff it is listed. Mutation-checked:
  dropping the ref check in `validateFacetWrite` fails two tests.

## Common mistakes (append as review finds them)

- Validating a registered facet's payload leniently on WRITE. Layer 2 is
  reject; only the storage READ layer drops.
