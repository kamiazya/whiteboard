---
paths:
  - "packages/facet-ui/**"
---

# facet-ui — the facet system's React half

## What belongs here

- **The primitives a plugin builds its settings UI from**, and the glyph
  vocabulary rendered (`glyphIcon`): the engine owns what may be *said*, this
  package owns how it *looks*.
- **`createFacetWriter`** — the one path a facet editor's value takes to
  storage. It goes through `validateFacetWrite`, so a plugin's own component
  cannot store what `wb_facet_set` would refuse. This is the guarantee half
  of the bargain; the look is a convention.
- **`definePluginUi`** — how a plugin says what its settings surface looks
  like: sections, their order, their headings, and (only where the declared
  editor vocabulary cannot reach) a component.
- **The bundled `visual` plugin's UI half.** Its data half lives in
  `facet-engine`. The split is the plugin's shape, not a privilege of being
  bundled — a third-party plugin is arranged the same way.

## What does NOT belong here

- Schemas, resolvers, migrations, write validation — those are
  `facet-engine`'s, and they must run where React cannot (`canvas-render`
  calls the resolvers on Node, in a worker and in the browser).
- Panel CHROME: where the inspector sits, how it docks, its close control.
  That is each vessel's (`apps/web`'s `FacetFormPanel` today).
- `react-dom`. This package renders elements and never mounts them.

## Styling: values and host tokens, never class names

**Utility class names do not work from a workspace package**, and the failure
is silent: Tailwind v4's content detection stops at the app, so a class named
only inside `packages/` is never generated and the component renders
unstyled. Measured — a `rotate-[7deg]` on a facet-ui component computed
`transform: none`, while `h-7` and `bg-accent` appeared to work *only*
because `apps/web` happens to use the same names. The control is what caught
it.

An `@source` line per vessel would fix it and is exactly the opt-in step
`architecture-map.md` warns about (the lowlight lesson). So: inline style
values, with theme colours read as the host's own custom properties
(`var(--accent, …)`, `var(--muted-foreground, …)`) plus a literal fallback,
so the component is legible even where no theme is defined.

## Dependency rules

- Runtime deps: `canvas-render` (the vendored icon geometry the
  badge picker draws from — so a picker can never offer a name the canvas
  would drop), `facet-engine`, `react`, `lucide-react`.
- Forbidden: `node:*`, `inversify`, `loro-crdt`, `react-dom`. DOM globals are
  exempted like `canvas-viewer`'s — a React UI package's normal job.

## Tests

- Vitest project: `facet-ui-jsdom`.
- The write barrier is tested by feeding it a payload the facet REFUSES
  (`visual.symbol`'s single-grapheme `char`) and asserting nothing reaches
  storage. Mutation-check it: remove the validation and it must go red.
