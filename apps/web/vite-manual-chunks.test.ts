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

  it('leaves a package whose path merely contains react-dom out of vendor-react', () => {
    // radix's popper reaches `@floating-ui/react-dom`. Matched as a substring,
    // it took all of floating-ui into vendor-react, which every first paint
    // modulepreloads, though no first-paint screen positions a popover.
    expect(
      manualChunks(
        '/repo/node_modules/.pnpm/@floating-ui+react-dom@2.1.9/node_modules/@floating-ui/react-dom/dist/floating-ui.react-dom.mjs',
      ),
    ).toBeUndefined()
    expect(
      manualChunks(
        '/repo/node_modules/.pnpm/@floating-ui+dom@1.8.0/node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs',
      ),
    ).toBeUndefined()
  })

  it('keeps the scheduler with react', () => {
    expect(
      manualChunks('/repo/node_modules/.pnpm/scheduler@0.27.0/node_modules/scheduler/index.js'),
    ).toBe('vendor-react')
  })

  it('leaves first-party source unassigned, so only vendors are pinned here', () => {
    expect(manualChunks('/repo/apps/web/src/pages/BrowserDocumentPage.tsx')).toBeUndefined()
  })
})
