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
  local area run for an `apps/web` move had not included `mcp-node`.
  `file-size-budget` is worse than a path list: it SCANS `apps/web/src`
  wholesale, so any web file crossing 800 lines fails a project no web
  command runs. Telling readers to add `--project mcp-node file-size-budget`
  was this rule's answer for a while, and a prose rung cannot notice being
  forgotten — the same push went out twice. **lefthook's pre-push block now
  runs it** — 7.7–10.7s across two measured runs, each of whose total was
  exactly the typecheck's own, so the gate is no slower — and the guard
  asserts that line exists. So a web change is covered without remembering
  anything; run it by hand only to shorten the loop.

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
runs the same composition, so the two threads cannot default apart. The
look, its resolver and where a theme's family counts as available are
`editorLayoutBase`, which the edge overlay a drag re-routes per frame
takes too — it used to build its own options and drew every edge clean. The
session override (decision 6) is the one thing that crosses: `DocumentPage`
holds it per tab and document, the Display panel's **Draw as** row sets it
(`onStyleChange`, offered only where a host passes one; the theme ids come
from the registry's `assetIds('themes')`, never a facet key), and it threads
`SpatialEditor` → `useWorkerScene` → the `LayoutRequest.style` field and
the drag layers alike. Absent means `'document'` on both threads.

Three consequences, each with its guard:

- **The render key gains no axis.** The theme is a canvas facet, so a
  document's content digest already changes when its theme does, and the
  registered assets are part of the build id. The session override reaches
  the editor alone — never the list surfaces — so no keyed surface draws a
  document in two looks, which is what would need an axis.
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
known, `FontsCard` triggers it again after an install, and the editor asks
`loadThemeFontFromSource` for the family its canvas draws in
(`useThemeFaceFor`, keyed on the family) — the catalogue's pinned source,
the same file the daemon installs, for the realm no daemon serves. The two
sources share one in-flight map, so whichever asks first lands the face. A
face lands three ways at once, and each is a seam the next change must keep:

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
  generation is only what makes it ask again;
- **the in-place editors** (node body, edge label, group label), through
  `useEditingFontFamily`: the family the scene DECLARES — the theme's where
  the face is held, the bundled one otherwise — never the theme's wish, or
  the draft moves on commit. Comment and proposal chrome stay bundled, as
  the layout keeps them crisp.

The PNG export carries a held face the same way it carries the vendored
one (`withViewerFontEmbedded(svg, themeFacesNamedBy(svg))`), and only the
faces the SVG names, since each is megabytes. A daemon that cannot be
listed is `log.info`, not a warning: it is the routine first render while a
connection settles, and the jsdom failure guard would otherwise fail every
App test that mounts a daemon target.

### A property over "a canvas with facets" draws them from the registry

`facetsArbitrary(registry, 'canvas')` from facet-engine's `/testing`
subpath is what a property about envelopes uses
(`gesture-view.property.test.ts`): each facet the registry holds for the
target, drawn from its own Zod schema by model's `arbitraryForSchema`
(`@kamiazya/whiteboard-model/test-utils`), an `assetRefs` field drawing
the registered asset ids, and every payload filtered by
`validateFacetWrite` itself so a `.refine` the walk cannot see is still
honoured. It follows a facet a plugin registers tomorrow without an edit.
The generator's own honesty is facet-engine's to test; what this app keeps
is `test-utils/facet-arbitrary.test.ts`, which pins that every canvas facet
in the BUNDLED registry is produced and nothing produced is refused — the
check that the plugin this app ships has no facet the walk throws on at
construction and none it quietly skips. It used to be a walker of its own
here, beside a second one in canvas-render that drew from form samples; two
properties on one PR passed over the defect they exist to catch because
each generator had a schema it had never met, and one walk in model — the
package every generator can reach — is the permanent answer.

### The settings migrations are total, and say so under a property

`lib/user-settings-store.property.test.ts` draws whole v1 and v2 payloads
from the legacy schemas (URL fields overridden to real http(s) URLs, since
a random string is never one) and requires `migrateV2(migrateV1(v1))` and
`migrateV2(v2)` to parse under the live `.strict()` schema while carrying
each field across by name, then reads both through the real store from
`localStorage` and round-trips a live payload through `save`/`load`. The
class it closes is the one `vocabulary.md` records: the loader falls back
to defaults on ANY parse failure, so a migration emitting one key the live
schema does not admit discards a user's whole payload silently. The
schemas and the two migrations are exported for it and for nothing else.

