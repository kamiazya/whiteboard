import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import {
  buildWidgetFontsModuleSource,
  resolveWidgetFontAssets,
} from './src/widget/build-fonts-module.js'
import { WIDGET_FONT_ASSETS } from './src/widget/font-assets.js'

const VIRTUAL_MODULE_ID = 'virtual:widget-fonts'
// Vite convention: prefixing the resolved id with `\0` tells other plugins
// (e.g. sourcemap remapping) this id is synthetic and must not be treated
// as a real file path.
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`

// This package vendors its own copy of the export font under
// assets/fonts/ (it cannot import mcp-server's copy across the package
// boundary — see architecture-map.md), so font resolution is a plain
// relative path, not a node_modules lookup.
function resolveWidgetFontsDir(): string {
  return fileURLToPath(new URL('./assets/fonts', import.meta.url))
}

// Bakes the fonts the widget needs (see src/widget/font-assets.ts) into a
// virtual module as base64 data URIs.
// Exported so vitest.jsdom.config.ts can register the same virtual module
// for widget-entry.ts's unit tests — that file imports `virtual:widget-fonts`
// unconditionally, so any test harness that loads it as source needs this
// plugin too, not just the production widget build.
export function widgetFontsPlugin(): Plugin {
  return {
    name: 'whiteboard-widget-fonts',
    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID
      return undefined
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return undefined
      const fontsDir = resolveWidgetFontsDir()
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
