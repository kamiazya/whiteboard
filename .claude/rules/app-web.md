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

Two traps a mechanical move does not see, each found by a test going red:
a `vi.mock('./x.js', …)` specifier is a string, not an import, and keeps
pointing at the old path (the spy then counts zero calls); and
`purity-guard.test.ts` scans its files by explicit relative path on
purpose, so a moved file falls out of it loudly rather than silently.

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
