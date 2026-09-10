---
paths:
  - "packages/scene/**"
---

# scene — the scene vocabulary and the renderer/plugin contract

## What belongs here

- `scene-graph.ts`: what a laid-out spatial document IS — the closed
  `SceneNode` union and everything it is built from (`BoundingBox`,
  `Appearance`, the block nodes a markdown body becomes, `ResolvedEdgeNode`,
  `Scene`). Plain TypeScript types, never Zod: a scene does not cross a
  process boundary, so per zod-schema-discipline it needs no runtime schema.
- `contribution.ts`: the shape a plugin contributes to drawing — `NodeOutline`,
  `ShapeContribution`/`ShapeTable`, `DecorationContext`/`NodeDecoration`,
  the edge-router contract (`EdgeRouteRequest`/`EdgeRoute`/`EdgeRouter`), and
  `RenderContribution` itself.

  A router returns a ROUTE — points, and whether they curve — never a scene
  node. Terminating on a silhouette, the arrowheads, the paint and the ink
  are the renderer's, and it applies them to every edge the same way; a
  router that built the node would be a second producer of that geometry,
  which is the drift canvas-render's one-producer rule exists to prevent.
  It receives the sides the anchor pass chose (that pass runs first, across
  the whole edge set, because fan-out needs to see every end sharing a
  side), so sides are its input rather than its answer.

A contribution SELECTS its router the way it selects a silhouette:
`routers` by bare name plus `readRouting` answering one, with the renderer
composing `${namespace}.${name}`. That is not ceremony — it is what stops a
document naming another plugin's algorithm, and it means a plugin stores
the choice in its OWN facet.

Measured, and the reason it is a reader: widening `visual.edges/v0`'s
`routing` to accept a namespaced id instead put the payload outside the
vocabulary `deriveFacetForm` can read, so the facet silently produced no
derived form — which is the routing control the inspector renders, and the
payload samples the layout's own property test draws from. The engine's
`facetPayloadSamples` caught it by answering with an empty list.

## Why the package exists

For its POSITION, not its contents. It sits below the renderer AND below
every plugin, so neither has to import the other to agree what a scene is.

Before it, the contract lived inside `canvas-render`, and a plugin importing
it closed a package cycle — held open only by every import back being
type-only. That property is invisible to a manifest, so it cost a
hand-written guard and an entry in arch-lint's `KNOWN_PACKAGE_CYCLES`, and
it only held while every import back was a type. A plugin-contributed edge
ROUTER is the second caller `architecture-map.md` said to wait for.

The extraction's own commit gave a WRONGER reason than that — it said a
router returns a scene node, which is a value, so the type-only trick was
about to stop working. The contract designed the next day returns a route
instead, for the reason above, so the trick would have held. Kept here
because the difference is the one worth teaching: what earned the package
is a second caller of a contract plus a debt no manifest can see, never a
prediction about what one caller's signature would force.

## What does NOT belong here

- Anything with a runtime value. `contract-position.test.ts` fails on an
  exported `const`/`function`/`class`, and the reason is not style: shared
  CODE is a different kind of package with different rules, where a change
  is a change to the renderer and to every plugin at once. A contract is a
  shape, and keeping it shapeless is what keeps it cheap.
- Layout, painting, hit-testing, digests — those PRODUCE and CONSUME the
  vocabulary and are `canvas-render`'s.
- A plugin's own facet schemas or resolvers, which are the plugin's.

## Dependency rules

- Runtime deps: `@kamiazya/whiteboard-model` and
  `@kamiazya/whiteboard-facet-engine`, and nothing else — the two packages
  the contract is written in terms of (a node/canvas it describes, and the
  theme tokens a contribution registers). Both are pinned by
  `contract-position.test.ts`, which also fails on any source importing
  `canvas-render` or a plugin.
- Forbidden, like every shared-layer package: `node:*`, DOM globals,
  `inversify`, `loro-crdt`.

## Conventions

- `canvas-render` RE-EXPORTS everything it moved, so its own public surface
  is unchanged and its ~80 consumers were untouched by the extraction. A new
  consumer may import from either; prefer this package when what it wants is
  the contract rather than the renderer.
- A type added here is a contract change for both sides at once. That is the
  cost of the position, and the reason to add one only when a plugin
  genuinely needs to speak it.

## Tests

- Vitest project: `scene-node` (registered in root `vitest.config.ts`).
- `contract-position.test.ts` is the whole suite, deliberately: there is no
  behaviour to test, so what it pins is the position (the manifest, the
  absence of upward imports) and the types-only rule. Each direction is
  mutation-checked — adding a runtime export fails it.
