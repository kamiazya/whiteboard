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
  about facets.** A short list, ONE search box, a category band, a scrolling
  grid, and what was picked recently. It takes loaded sections, a
  selected key and a callback, so the markdown editor's `:name:` popup is
  the same control rather than a second one that drifts. Every band of it is
  `FacetOption`, the category band included — the sections and the cells
  differ only in their radio NAME, because one is a view and the other is
  the value. The category band is a `grid` rather than a chip row for a
  measured reason: nine glyph-only chips are 304px of a 302px panel, so the
  last one wrapped onto a line of its own.
- **`FacetCatalogPicker` — the facet adapter over it**, and deliberately
  thin: it loads what the facet's `catalog` declares and routes EVERY value
  it offers — a loaded row as much as typed text — through
  `registry.validateFacetWrite`. How little it does is the honest measure of
  how generic the control below it actually became.

  That validation seam is the point rather than a detail: `CatalogPicker`
  holds no rule about what a symbol may be, so it cannot hold a laxer one
  than the facet does, and a surface with no schema behind it simply passes
  no seam.

  It covered free entry ALONE at first, on the belief — written into this
  file and into the adapter's own comment — that "the write path still
  refuses a bad row". It does not. `apps/web`'s `FacetFormPanel` validates
  a HAND-WRITTEN editor's write and passes `onWrite` straight into
  `DerivedFacetForm`, and the `set-node-facet` / `set-edge-facet` /
  `set-canvas-facet` mutators store the payload they are handed. So the
  adapter was the last place that knew which facet was being written and
  the only one that could refuse, and a loader's row reached storage
  unparsed. Caught in review on this PR, not by a test — which is why the
  test exists now.

  At the PICK rather than over the loaded sections, measured: validating
  the bundled catalog's 1914 rows costs 15-23ms of the thread that just
  opened the panel, on every open. A row the facet refuses is a plugin
  defect its own catalog test owes; paying a frame per open to soften it is
  the wrong trade, and what this must not do — let it reach storage — it
  does not.

  **Free entry has no input of its own.** It was a field plus an apply
  button beside the search box, and the two were one gesture twice — the
  search already matches a pasted CHARACTER, so only one of the two wrote
  anything and nothing said which. The typed text is now offered as the
  LEADING CELL when it is a value the catalog does not already have, which
  is where `validateEntry` is consulted: a refusal means the cell is not
  drawn, so an invalid value cannot be taken and then reported. `known`
  covers the recently-used band as well as the rows, because after typing a
  new symbol it is in recents and offering it again is the duplicate the
  rule exists to avoid.
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

  **The top layer is not a scroll container either, and neither is
  `position: fixed`** — so escaping the inspector's clipping buys nothing
  on its own. A catalog opened from a row low in the viewport, which is
  where the last facet in the panel always is, placed itself below the fold
  entire: measured at 866..1014 of a 900px viewport, 34px of it on screen
  and nothing to scroll to the rest. `place()` therefore picks the side
  with room, and caps `maxHeight` at what that side has with `overflowY`
  under it. Two traps it has to know about:

  - **The UA stylesheet gives `[popover]` `inset: 0`.** Clearing `top` does
    not leave it unset, it leaves it at `0`, and the over-constrained rule
    then drops the `bottom` that was supposed to anchor the panel above its
    trigger. Both edges are written every placement, `auto` where they do
    not apply.
  - **A browser case cannot reach this by standing the host low.** The page
    scrolls itself when the inspector takes focus, so where the trigger
    ends up is the browser's decision: an 820px spacer left 368px of
    clearance and a 300px-tall viewport left 198px, both more than the
    panel's own 146, and the case passed against the unfixed placement in
    each. Scroll the trigger to a chosen offset after opening, and probe
    the premise that actually matters — the room under it is less than the
    panel's `scrollHeight`, not that the trigger is "low".

  Recents are MODULE state, keyed by the picker's `name` — the picker
  unmounts every time its popover closes, which is the one moment recents
  are for. That makes them leak between TESTS too, so both apps/web setups
  call `clearCatalogRecents()` in `afterEach`; without it one test's pick
  shows up as an extra radiogroup in the next test's panel, which is how it
  was found.
- **`EMOJI_FONT_STACK` / `EmojiText` — an emoji drawn by a font that has it
  in COLOUR.** Left to the inherited UI stack, an emoji is drawn by whichever
  installed font claims its codepoint first, and several ordinary text faces
  claim the common ones as monochrome outlines. Measured in this repo's own
  headless Chromium: `fc-match sans-serif` answers DejaVu Sans, which covers
  U+1F600, so 😀 😃 🙂 ☺️ ♠️ 🏁 drew as grey line art beside 🤣 🥰 ⭐ 🔥 in
  full colour — one grid, two kinds of picture, and nothing in the data to
  explain it. It is not container-only: the same split happens on any machine
  whose UI font covers part of the emoji block, and WHICH part depends on the
  machine.

  `glyphIcon`'s `char` arm goes through it, so every surface drawing a char
  glyph is fixed in one place, and `plugin-visual`'s `SymbolMark` imports the
  same component for the minimap. `Segoe UI Symbol` is deliberately absent
  from the stack: it is Windows's MONOCHROME emoji face, and listing it is
  how a stack meant to force colour quietly reintroduces the outlines.

  Pinned at both layers, because neither alone is enough: the jsdom case
  asserts the declaration reaches the cell (jsdom computes no fonts), and
  `node-symbol-menu.browser.test.tsx` asserts the COMPUTED family survives
  the real cascade — which is where a panel-wide font rule would override
  it. Neither can prove which face actually won; no API reports that.
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
