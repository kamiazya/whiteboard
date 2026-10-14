/**
 * Which third-party modules get a chunk of their own.
 *
 * Extracted from `vite.config.ts` so `vite-manual-chunks.test.ts` can assert
 * on the rule directly: the hazard below is invisible in every test that
 * runs against source, and only appears in a minified production bundle.
 */
// A package by its own directory: `@floating-ui/react-dom` ends in
// `/react-dom/` too, and a substring match took it — and, with it, every
// floating-ui module it imports — into vendor-react, which every first paint
// modulepreloads though no first-paint screen positions a popover.
const REACT = /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/

export function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined
  if (REACT.test(id)) return 'vendor-react'
  // Icons get a chunk of their own, and it is not cosmetic. Left
  // unassigned they are merged into whichever chunk imports them —
  // which for this app is one carrying the Loro WASM's TOP-LEVEL
  // AWAIT. Rolldown compiles such a chunk to `let Copy, Undo2, …`
  // declared at module scope and assigned inside the TLA body, so
  // every icon it exports reads `undefined` until that body runs.
  // A component rendering one then calls createElement(undefined)
  // and React throws #130 with no name in it. Measured on the
  // document kebab: `Copy` (the Duplicate row) was undefined and
  // took the whole page to the error screen — minified only, since
  // an unminified build lays the module out differently and hides
  // it entirely.
  if (id.includes('/lucide-react/')) return 'vendor-icons'
  return undefined
}
