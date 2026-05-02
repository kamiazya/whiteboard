// Vendored facade for the `@excalidraw/utils` surface our daemon uses.
// See ../README.md for why we're a facade rather than a full source vendor.
//
// Implementation note: `@excalidraw/utils@0.1.3-test32` ships its types under
// `dist/types/utils/src/index.d.ts` whose chain of `export * from "./..."`
// re-exports does not propagate through TypeScript's NodeNext namespace
// narrowing. Importing `exportToSvg` directly fails the type check even
// though the module exports it at runtime. We declare the surface locally
// and route the runtime through `Object.assign` so callers get a typed
// import without dragging in the broken upstream type chain.

import * as upstream from '@excalidraw/utils'

interface ExportToSvgOpts {
  elements: ReadonlyArray<Record<string, unknown>>
  appState?: Record<string, unknown>
  files?: Record<string, unknown> | null
  exportPadding?: number
  renderEmbeddables?: boolean
  exportingFrame?: unknown
  skipInliningFonts?: boolean
  reuseImages?: boolean
}

interface ExcalidrawUtilsSurface {
  exportToSvg(opts: ExportToSvgOpts): Promise<{ outerHTML: string }>
  MIME_TYPES: Record<string, string>
}

// Cast through `unknown` so the value is reachable even though TS sees the
// namespace as empty. Both members exist at runtime (verified via smoke).
const surface = upstream as unknown as ExcalidrawUtilsSurface

export const exportToSvg = surface.exportToSvg
export const MIME_TYPES = surface.MIME_TYPES
export type { ExportToSvgOpts }
