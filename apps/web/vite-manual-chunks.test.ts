/**
 * The chunk-splitting rule, asserted directly.
 *
 * This guard exists because the defect it pins is invisible to every other
 * test in this repo: the whole `web-browser` suite runs against source, and
 * an unminified production build does not reproduce it either. It reached a
 * deployed preview and took the document page to the error screen.
 */
import { describe, expect, it } from 'vitest'
import { manualChunks } from './vite-manual-chunks.js'

const LUCIDE =
  '/repo/node_modules/.pnpm/lucide-react@1.28.0/node_modules/lucide-react/dist/esm/icons/copy.js'

describe('manualChunks', () => {
  it('gives lucide-react a chunk of its own, away from the WASM top-level await', () => {
    // Unassigned, the icons merge into whichever chunk imports them — here
    // one carrying loro's TLA. Rolldown then emits `let Copy, …` at module
    // scope, assigned inside the TLA body, so the export reads `undefined`
    // and the component rendering it calls createElement(undefined).
    expect(manualChunks(LUCIDE)).toBe('vendor-icons')
  })

  it('keeps react in its own chunk', () => {
    expect(manualChunks('/repo/node_modules/.pnpm/react@19.0.0/node_modules/react/index.js')).toBe(
      'vendor-react',
    )
    expect(
      manualChunks('/repo/node_modules/.pnpm/react-dom@19.0.0/node_modules/react-dom/client.js'),
    ).toBe('vendor-react')
  })

  it('leaves first-party source unassigned, so only vendors are pinned here', () => {
    expect(manualChunks('/repo/apps/web/src/pages/BrowserDocumentPage.tsx')).toBeUndefined()
  })
})
