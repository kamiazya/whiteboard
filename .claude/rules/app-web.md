---
paths:
  - "apps/web/**"
---

# apps/web — the browser composition root

## Layers, bottom to top

`src/layer-order.test.ts` is the executable half of this section; the order
it declares is:

| layer | holds | may import |
|---|---|---|
| `lib/` (+ root `runtime-config.ts`) | browser-only mechanics: stores, adapters, workers, pure helpers. No React | packages, `lib/` |
| `pwa/` | service-worker registration and its update scheduler | `lib/` |
| `contexts/` | React context objects and their providers | `lib/`, `pwa/` |
| `hooks/` | React state over lib | everything below |
| `components/` | rendering | everything below |
| `pages/` | route-level screens, each `React.lazy` | everything below |
| root (`App.tsx`, `boot.ts`, `boot-splash.ts`, `main.tsx`) | composition | everything |

An edge points DOWN that order or it is a filing mistake: the type or helper
the lower module wanted was written under the screen that first needed it
and never moved. `runtime-config.ts` sits at the root because the README
and ADR-0002 name it there, and is filed with `lib/`, which is what it is.
`test-utils/`, `test-config/`, `docs-snapshots/` and every `*.test.*` are
exempt — a test that composes a whole page as its fixture is doing setup.

**Type-only edges count.** tsc erases them, so the bundle never sees the
inversion, but a `lib/` module that names `EditorCommand` from a component
is a `lib/` module whose contract is defined above it. The guard tags them
`(type)` so the burn-down can read which is a type move and which a helper
move.

## The debt, and how it was paid

Measured when the guard landed: 21 upward edges, 15 of them `import type`,
every one allowlisted in `UPWARD_EDGES` with the length pinned by equality
and each entry checked to still be a real edge — an entry cannot outlive
what it names. The list is EMPTY now and stays declared, so a new upward
edge has a place to be refused rather than a place to be written down:
move what the lower module needs down, never add to the list.

How it was burned down, in the order that paid best — kept because the
same shapes will recur, and each was cheaper than it looked:

1. **Pure modules out of `components/`** (6): `document-entry`,
   `files-source`, `rail-geometry`, `link-target` → flat in `lib/`. None
   knew React; the two files-source implementations in `lib/` had been
   importing their own contract from above.
2. **Types into `lib/`** (8, no runtime change): `ThemeMode` /
   `ResolvedTheme` → `lib/theme`, `LoadedFileDocument` /
   `DocumentFileAdapter` → `lib/document-file-contract`, `SessionHealth` /
   `ConnectionState` / `isSyncOff` → `lib/connection-state`, `EditorTool` →
   `lib/editor-tool`, `BrowserPersistenceState` →
   `lib/browser-persistence-state`. The hook or component that owned each
   now imports it like everyone else; nothing re-exports the old path.
3. **The spatial editor's pure core** (4): `viewport`, `geometry`,
   `minimap`, `commands` → `lib/spatial/`, with `SpatialEditorHandle`
   beside the `Viewport` it names (`lib/spatial/editor-handle`).
4. **The render glue the layout worker runs off the main thread** (3):
   `scene-render`, `scene-render-core` and the `editor-appearance` they
   thread the theme through → `lib/spatial/`; `render-preview` →
   `lib/`. A worker importing from `components/` was the clearest sign
   those were never components.

Three things a mechanical move does not see, and what catches each now:

- A `vi.mock('./x.js', …)` specifier is a string, not an import, so it keeps
  pointing at the old path and mocks nothing — the test runs against the
  real module and stays green. Found once by a spy that happened to count
  its calls; measured afterwards, two more had been dead since the
  component they mocked was deleted. `mock-specifiers.test.ts` resolves
  every relative and `@/` mock specifier the way the layer guard resolves
  imports and fails on one that names no module. Not a GritQL rule: a
  Biome plugin sees one file's syntax and cannot know whether a path
  exists.
- `purity-guard.test.ts` (apps/web) and `file-size-budget.test.ts`
  (mcp-server) hold files by explicit path on purpose and check the path
  still exists, so a move fails them loudly — the second in CI, because the
  local area run for an `apps/web` move had not included `mcp-node`. It
  does now: a move runs `--project mcp-node file-size-budget` alongside the
  web guards.

## What the other guards already cover

- `packages/mcp-server/src/server/release/web-app-boundary.test.ts` — what
  this app may import from `@kamiazya/whiteboard-mcp` (browser-safe
  subpaths only) and that no relative import reaches the daemon's `src/`.
- `src/entry-graph-loro-free.test.ts` — `App.tsx`'s static closure never
  reaches loro; the workspace machinery stays behind the lazy page boundary.
- `src/component-reach.test.ts` — every component under `components/` and
  `pages/` has a non-test importer.
- `tools/arch-lint` — the package-level direction check; this app is a
  composition root there, allowed `node:*`-free DOM and inversify-free
  React, and never imported by a shared package.

None of them sees an edge INSIDE `src/`, which is the gap `layer-order`
closes.

## The document's theme (ADR-0030)

`lib/spatial/scene-render-core.ts` is the ONE composition of
`layoutSpatialCanvas` this app has, and it defaults `style` to `'document'`
there: a person editing a board sees the theme it names, and every surface
that pictures a document — the editor, its drag layers, the row thumbnail,
the preview pane, the export — pictures the same look. The layout worker
runs the same composition, so the two threads cannot default apart and the
worker protocol carries no style field at all; `'clean'` is a session
override a caller passes, and nothing passes one today.

Three consequences, each with its guard:

- **The render key gains no axis.** The theme is a canvas facet, so a
  document's content digest already changes when its theme does, and the
  registered assets are part of the build id. A style axis would only be
  needed if one surface drew a document in two looks, and none does.
- **The paper is the palette's surface for the UI mode**, painted by
  `SpatialEditor` on its root (`resolveCanvasPalette(canvas, theme).surface`).
  The bundled palette's surface IS the page background in both modes, so an
  unthemed canvas is byte-identical to before; neon gets its night.
  `SpatialEditor.test.tsx` pins both.
- **Colour swatches preview the palette the canvas is drawn in.**
  `colorRow` takes a `SpatialPalette` rather than a mode, and
  `CanvasContextMenu` resolves it once with `resolveCanvasPalette` — a
  canvas-render export, so the point-owning surfaces still name no facet
  domain (`facet-wiring-guard.test.ts`).

The Theme row in the Display panel is `derivedCanvasFacetRow` in
`facet-widgets/index.tsx`: `facet-ui`'s `DerivedFacetForm` over the plugin's
own `editor` spec, writing through `set-canvas-facet`. Registering a theme is
registering an asset; nothing on this side changes. `canvas-theme-row.test.tsx`
(jsdom) and `canvas-settings.browser.test.tsx` cover the row and the pick.

### A theme's family reaches this app from the daemon

`lib/theme-fonts.ts` is ADR-0012's browser half, scoped to the families a
registered theme names (`themeFontFamilies`, read off the facet registry's
theme assets) and nothing else — an installed CJK face stays an export
concern. `App` triggers `loadThemeFonts` when `daemonShellTarget` becomes
known, and `FontsCard` triggers it again after an install. A face lands
three ways at once, and each is a seam the next change must keep:

- **the main thread**, through canvas-viewer's `registerFontBytes`, so
  `hasLoadedFace` — the `fontAvailable` the composition passes — answers
  true;
- **every layout worker**, through `attachThemeFaces` on BOTH creators
  (the shared pool's `createWorker` and the editor's `createLayoutWorker`),
  which posts each held face now and each later one as it lands, and is
  detached with the worker's `terminate`. The worker handles
  `register-face` before any layout reads the face set. Missing either
  creator is the parity defect the worker exists to avoid: one realm would
  declare the theme family and the other the bundled one, and the two
  scenes would differ in every wrapped line. `layout-worker-theme-face.browser.test.tsx`
  pins the worker half in a real browser;
- **the scene**, through `useThemeFontsGeneration` in the editor's
  `useWorkerScene` inputs — the layout asks `hasLoadedFace` itself, so the
  generation is only what makes it ask again.

The PNG export carries a held face the same way it carries the vendored
one (`withViewerFontEmbedded(svg, themeFacesNamedBy(svg))`), and only the
faces the SVG names, since each is megabytes. A daemon that cannot be
listed is `log.info`, not a warning: it is the routine first render while a
connection settles, and the jsdom failure guard would otherwise fail every
App test that mounts a daemon target.

