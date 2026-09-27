import { defineConfig } from 'vite'
import { type BuildMode, manifestFor } from './src/manifest.js'

// One service worker, bundled with what it imports, and the manifest for the
// build's mode beside it: the directory Chromium's "Load unpacked" takes —
// dist/production for everyday use, dist/development to reach a dev server.
export default defineConfig(({ mode }) => ({
  build: {
    target: 'es2022',
    outDir: `dist/${mode}`,
    lib: { entry: 'src/background.ts', formats: ['es'], fileName: () => 'background.js' },
    minify: false,
  },
  plugins: [
    {
      name: 'whiteboard-extension-manifest',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.json',
          source: `${JSON.stringify(manifestFor(mode as BuildMode), null, 2)}\n`,
        })
      },
    },
  ],
}))
