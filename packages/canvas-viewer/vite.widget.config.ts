import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import {
  buildWidgetFontsModuleSource,
  resolveWidgetFontAssets,
} from './src/widget/build-fonts-module.js'
import { WIDGET_FONT_ASSETS } from './src/widget/font-assets.js'

const require = createRequire(import.meta.url)

const VIRTUAL_MODULE_ID = 'virtual:widget-fonts'
// Vite convention: prefixing the resolved id with `\0` tells other plugins
// (e.g. sourcemap remapping) this id is synthetic and must not be treated
// as a real file path.
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`

function resolveExcalidrawFontsDir(): string {
  // No `./package.json` subpath in @excalidraw/excalidraw's `exports` map, so
  // resolve the real entry point instead and derive the fonts dir from it.
  // `production` is forced via customConditions because this is a prod vite
  // build and the fonts only exist under dist/prod, not dist/dev.
  const entryPath = require.resolve('@excalidraw/excalidraw', {
    // @ts-expect-error -- Node's resolve options type doesn't include customConditions yet.
    customConditions: ['production'],
  })
  return join(dirname(entryPath), 'fonts')
}

// Bakes the fonts the widget needs (see src/widget/font-assets.ts) into a
// virtual module as base64 data URIs, resolved fresh on every build so the
// output always matches the currently installed @excalidraw/excalidraw
// version's font files.
function widgetFontsPlugin(): Plugin {
  return {
    name: 'whiteboard-widget-fonts',
    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID
      return undefined
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return undefined
      const fontsDir = resolveExcalidrawFontsDir()
      const resolved = resolveWidgetFontAssets(WIDGET_FONT_ASSETS, (file) =>
        readFileSync(join(fontsDir, file)),
      )
      return buildWidgetFontsModuleSource(resolved)
    },
  }
}

export default defineConfig({
  plugins: [react(), widgetFontsPlugin(), viteSingleFile()],
  build: {
    outDir: 'dist/widget',
    // A single self-contained artifact has no meaningful chunk boundaries;
    // this also keeps vite-plugin-singlefile's job simple (one JS bundle,
    // one CSS bundle, both inlined into the HTML).
    cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./canvas-viewer.widget.html', import.meta.url)),
      output: {
        entryFileNames: 'canvas-viewer.js',
      },
    },
  },
})
