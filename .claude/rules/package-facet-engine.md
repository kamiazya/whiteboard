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
  chain, drop-not-fail, newer-than-registered preserved).
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
  vocabulary (`text`/`number`/`toggle`/`choice`/`segmented`, glyphs from
  `FACET_GLYPHS`). `deriveFacetForm(schema, editor)` merges it over the
  derived form; `assertEditorSpecFits` rejects at definition time a spec
  naming a field the schema does not declare, or one on a schema with no
  derivable form. A segmented option's `value: null` means the facet's
  ABSENCE — some defaults are unrepresentable as a stored value (a rect
  node stores no shape facet), and a picker with no way to say that
  cannot express them. The bundled `visual.shape` declares its band this
  way and ships NO hand-written widget, which is how the mechanism is
  proved by the plugin that ships with the engine.

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

## Common mistakes (append as review finds them)

- Validating a registered facet's payload leniently on WRITE. Layer 2 is
  reject; only the storage READ layer drops.
