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

## The debt, and its burn-down

Measured when the guard landed: 21 upward edges, 15 of them `import type`,
every one allowlisted in `UPWARD_EDGES` with the length pinned by equality
and each entry checked to still be a real edge — an entry cannot outlive
what it names. Shrink the list by moving the TARGET down, then delete the
line and lower the ceiling; never add to it for new code.

Done so far, in the order that paid best:

1. **Pure modules out of `components/`** (retired 6): `document-entry`,
   `files-source`, `rail-geometry` and `link-target` now live flat in
   `lib/` — none of them knew React, and the two files-source
   implementations in `lib/` were importing their own contract from above.

Still open (15):

2. **Types into `lib/`** (13 edges, no runtime change): `ResolvedTheme` out
   of `hooks/useThemeMode` (3 importers in `lib/`, 21 overall),
   `DocumentFileAdapter` / `LoadedFileDocument` out of
   `hooks/use-document-file-seams` (2), `EditorCommand` /
   `EditorLeafCommand` out of `spatial-editor/commands` (2), and one each
   of `ConnectionState`, `SpatialEditorHandle`, `EditorTool`,
   `BrowserPersistenceState`.
3. **The render glue `lib/layout-worker.ts` runs off the main thread**
   (3 value edges): `spatial-editor/scene-render`, `scene-render-core`,
   `markdown-editor/render-preview`. A worker importing from
   `components/` is the clearest sign those are not components.
4. **`spatial-editor/minimap`** (1 value edge, `favicon.ts` draws the
   favicon with it): pure, but it reads `NodeBox` from
   `spatial-editor/geometry`, which reads `Point` from `viewport` — so it
   moves with that pair or not at all; 21 importers of `geometry` say
   this is its own increment.

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
