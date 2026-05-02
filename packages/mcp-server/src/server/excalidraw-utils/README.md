# excalidraw-utils (vendored facade)

This directory mirrors the surface from
[`excalidraw/excalidraw/packages/utils`](https://github.com/excalidraw/excalidraw/tree/main/packages/utils)
that our headless export pipeline consumes (`exportToSvg`,
`MIME_TYPES`).

## Why a facade rather than a full source vendor

The upstream wrapper source delegates to internal modules behind
`@excalidraw/excalidraw/scene/export`, `…/data/restore`, and friends.
At runtime two artefacts can serve those modules:

- **`@excalidraw/utils@0.1.3-test32` on npm** — self-bundled (RoughJS,
  png-chunks, perfect-freehand, etc. inlined into one ESM file). Loads
  cleanly under Node's strict `"type": "module"` resolver. **This is
  what we currently import.**
- **`@excalidraw/excalidraw@0.18.1` on npm** — re-exports the same
  wrapper from its main entry, but the bundle uses extensionless paths
  (`import 'roughjs/bin/rough'`) that Node refuses to resolve. Browser
  bundlers paper over this; Node does not.

A pure source vendor would require us to ship our own bundle that
inlines every transitive dependency — significant build work for no
behaviour change beyond what `@excalidraw/utils` already gives us.

The facade in `src/export.ts` pins all daemon-side imports to this one
path, so when upstream stabilises (a stable `@excalidraw/utils@0.2.x`
release, or `@excalidraw/excalidraw` shipping a Node-friendly bundle)
we can swap the dependency in one file and keep callers untouched.

## Source upstream (for reference)

- Repo: <https://github.com/excalidraw/excalidraw>
- Path: `packages/utils/`
- Wrapper logic at `0.18.1`: commit
  `a2ec2889babf7d2295469c6d90ebe77fae57df84`
- Wrapper logic on `main`: commit
  `278cd357724b17e1119b6c76416520c42958d0e3` (split into
  `src/export.ts`, `src/bbox.ts`, `src/withinBounds.ts`,
  `src/shape.ts`)

If a future change forces us to vendor the full source rather than
re-export `@excalidraw/utils`, copy from the appropriate commit above
and bundle the transitive deps via rolldown / esbuild before shipping.

## Surface

- `exportToSvg` — wrapped, calls `restore()` then the renderer.
- `MIME_TYPES` — re-exported constant table.

`exportToCanvas`, `exportToBlob`, and `exportToClipboard` are not yet
re-exported because no daemon-side caller needs them. They touch
`document.createElement('canvas')` and `HTMLCanvasElement.toBlob`,
which would require widening `lib` to include `dom` for at least this
file. Add them only when a real caller arrives.

## Tests

Upstream's `packages/utils/tests/export.test.ts` depends on
`@excalidraw/excalidraw/tests/fixtures/diagramFixture`, which is not
part of any published artefact. The wrapper is exercised end-to-end
through the real headless pipeline in
`../export/headless-renderer.test.ts` (jsdom + @napi-rs/canvas + resvg-js).
