import { describe, expect, it } from 'vitest'
import '../excalidraw-asset-path.js'

// vite.config.ts copies @excalidraw/excalidraw/dist/prod/fonts → dist/fonts so the
// app is self-contained. Without window.EXCALIDRAW_ASSET_PATH Excalidraw fetches
// fonts from esm.sh instead, which the CSP (default-src 'self') blocks — every
// lazy font load fails and text falls back to system fonts.
describe('excalidraw asset path', () => {
  it('pins Excalidraw asset loading to the self-hosted origin', () => {
    expect(window.EXCALIDRAW_ASSET_PATH).toBe('/')
  })
})
