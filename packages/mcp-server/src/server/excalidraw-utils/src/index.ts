// Vendored re-exports — keep parity with excalidraw/excalidraw monorepo's
// `packages/utils/src/index.ts`. Only the surface we actually use is exposed.
// If a future caller needs `withinBounds`, `bbox`, or `shape`, vendor those
// files alongside `export.ts` and add them here.
export * from './export.js'
