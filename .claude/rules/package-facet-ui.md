---
paths:
  - "packages/facet-ui/**"
---

# facet-ui — the facet system's React half

## What belongs here

- **The primitives a plugin builds its settings UI from**, and the glyph
  vocabulary rendered (`glyphIcon`): the engine owns what may be *said*, this
  package owns how it *looks*.
- **`FacetOptionGroup` / `FacetOption` — the ONE drawing of "pick one of N".**
  Not a suggestion: it is `createFacetWriter`'s bargain applied to rendering.
  A plugin chooses what its options are and their order; it does not choose
  what a selected option looks like. There were six spellings of this control
  before it, four of them in one panel, because every surface that needed one
  drew it again in a file that could not see the last. Real radios, visually
  hidden — the arrow-key behaviour comes free with the element, and the
  `aria-pressed` button rows never had it.
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

- Runtime deps: `facet-engine`, `react`, `lucide-react`. Icon geometry now
  reaches a picker as REGISTERED ASSET DATA through the registry
  (`glyphIcon`'s `asset` arm over `registry.iconAsset`), so this package
  needs no dependency on whoever vendored it — and the same bytes reach the
  canvas renderer and a DOM-free export, which a component never could.
  The `theme` arm is the same road for a LOOK: registered geometry inked
  the way a registered theme inks it (`ink`, `glow`), so a theme option
  shows the look rather than one flat stroke beside a word. It reads no
  palette on purpose — a theme carries both mode halves and the canvas
  surface follows the UI, so a swatch would have to know which mode the
  panel is in to pick honestly. `currentColor` leaves exactly the
  difference the option is choosing.
- Forbidden: `node:*`, `inversify`, `loro-crdt`, `react-dom`. DOM globals are
  exempted like `canvas-viewer`'s — a React UI package's normal job.

## Tests

- Vitest project: `facet-ui-jsdom`.
- The write barrier is tested by feeding it a payload the facet REFUSES
  (`visual.symbol`'s single-grapheme `char`) and asserting nothing reaches
  storage. Mutation-check it: remove the validation and it must go red.
- A declared picker has a SECOND net above that one, and it is the reason
  the vocabulary beat the escape hatch: every option's payload is parsed by
  the facet's own schema at `defineFacet` time
  (`facet-engine/src/picker.test.ts`), so a typo in one of twelve options
  stops the plugin instead of shipping as a choice that silently does
  nothing.
