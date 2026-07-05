// Point Excalidraw's lazy asset loading (fonts) at our own origin instead of the
// esm.sh CDN default. vite.config.ts copies @excalidraw/excalidraw/dist/prod/fonts
// into dist/fonts, and the CSP (default-src 'self') blocks cross-origin font
// fetches — so self-hosting is not just offline-friendliness, it is required.
//
// This module must be imported before anything that pulls in @excalidraw/excalidraw
// (see the import order in main.tsx): Excalidraw reads the global when it registers
// fonts.

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string
  }
}

window.EXCALIDRAW_ASSET_PATH = '/'

export {}
