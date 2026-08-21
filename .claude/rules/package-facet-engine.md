# facet-engine — the facet engine (ADR-0013)

## What belongs here

- `defineFacet` / `definePlugin` factories and the `FacetDefinition` /
  `FacetPlugin` shapes (definition-time grammar checks throw — programmer
  error, not data).
- `createFacetRegistry`: per-plugin-id collision check, `targetsOf`,
  write-side validation (`validateFacetWrite`, ADR-0013 decision 6) and
  read-side compat resolution (`resolveFacetPayload`, decision 7 — stepwise
  chain, drop-not-fail, newer-than-registered preserved).
- The bundled `visual` plugin and its facet schemas, plus resolvers that give
  consumers one read path (`resolveCanvasEdgeStyle`: facet first, legacy
  `x-whiteboard.edgeRouting` fallback).

## What does NOT belong here

- Facet KEY grammar and the `facets` bucket schemas — those are model's
  (`extensionFacetsSchema`); this package constructs keys and a test
  cross-checks them against model's grammar.
- Storage, rendering, transport, UI, contribution-point machinery (later
  increments), Inversify.

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
