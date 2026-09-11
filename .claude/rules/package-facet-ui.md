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

  Two DECLARED LAYOUTS, chosen by the plugin per row and drawn here: `cards`
  is a picture over its word in a bordered cell (a short vocabulary whose
  names carry meaning), `chips` is the picture alone with the word as its
  accessible name and `title` (a palette where the count makes labels
  impossible). A third, `grid`, is NOT declarable — square glyph-only cells,
  hundreds of them, which is what a catalog IS rather than a question about
  one row's vocabulary. Two ARIA SHELLS is a separate axis — `group` for a
  panel, `menu` for a menu row, which ignores the layout because a grid of
  cells inside a menu is not a menu. Neither axis is a style choice: one
  says what question the row asks, the other says what container it stands
  in.
- **`CatalogPicker` — a searchable catalog of choices, and it knows NOTHING
  about facets.** A short list, a search box, a category band, a scrolling
  grid, what was picked recently, free entry. It takes loaded sections, a
  selected key and a callback, so the markdown editor's `:name:` popup is
  the same control rather than a second one that drifts. Every band of it is
  `FacetOption`, the category band included — the sections and the cells
  differ only in their radio NAME, because one is a view and the other is
  the value. The category band is a `grid` rather than a chip row for a
  measured reason: nine glyph-only chips are 304px of a 302px panel, so the
  last one wrapped onto a line of its own.
- **`FacetCatalogPicker` — the facet adapter over it**, and deliberately
  thin: it loads what the facet's `catalog` declares and routes free entry
  through `registry.validateFacetWrite`. How little it does is the honest
  measure of how generic the control below it actually became.

  That validation seam is the point rather than a detail: `CatalogPicker`
  holds no rule about what a symbol may be, so it cannot hold a laxer one
  than the facet does, and a surface with no schema behind it simply passes
  no seam.
- **`CatalogPopover` — the trigger and the panel it opens.** A catalog is
  hundreds of cells and a property row is one line; inline, `visual.symbol`
  was taller than every other facet in the panel put together. Two things it
  must do, and both are why it is a component rather than a `<details>`: the
  panel has to escape the inspector's scroll clipping (the native Popover
  API's TOP LAYER, which brings light dismiss and Escape with it), and its
  content must not mount until it is opened (or the catalog's dynamic-import
  chunk is fetched for every row on screen).

  **jsdom implements none of the Popover API** — measured, `showPopover` is
  `undefined` and `popover` is not even a property — so the non-native path
  is not a legacy fallback: it is the path `catalog-popover.test.tsx` runs,
  while `node-symbol-menu.browser.test.tsx` runs the native one. Both are
  covered, and the feature test is at MODULE scope because the answer
  decides how the trigger is wired before the first render (with the API,
  the browser owns open/close and the trigger is `popovertarget`, so light
  dismiss knows the trigger belongs to the panel and a press on it does not
  close-then-reopen).

  Recents are MODULE state, keyed by the picker's `name` — the picker
  unmounts every time its popover closes, which is the one moment recents
  are for. That makes them leak between TESTS too, so both apps/web setups
  call `clearCatalogRecents()` in `afterEach`; without it one test's pick
  shows up as an extra radiogroup in the next test's panel, which is how it
  was found.
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
- A CATALOG's rows get neither net at definition time, because a loader is
  not loaded then. The write path still refuses a bad row, so nothing
  invalid is stored; what is lost is the plugin failing to start. The rows
  are the plugin's data, so the plugin owes the check —
  `plugin-visual/src/emoji/catalog.test.ts` parses all 1914.
