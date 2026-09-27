import { build, defineConfig } from 'vite'
import { type BuildMode, firefoxManifestFor, manifestFor } from './src/manifest.js'

// One background script, bundled with what it imports, and the manifest for
// the build's mode beside it: the directory the browser loads unpacked —
// dist/production for everyday use, dist/development to reach a dev server,
// and dist/firefox-<mode> for Firefox.
export default defineConfig(({ mode }) => {
  const firefox = mode.startsWith('firefox-')
  const buildMode = (firefox ? mode.slice('firefox-'.length) : mode) as BuildMode
  const outDir = `dist/${mode}`
  return {
    build: {
      target: 'es2022',
      outDir,
      lib: { entry: 'src/background.ts', formats: ['es'], fileName: () => 'background.js' },
      minify: false,
    },
    plugins: [
      {
        name: 'whiteboard-extension-manifest',
        generateBundle() {
          const manifest = firefox ? firefoxManifestFor(buildMode) : manifestFor(buildMode)
          this.emitFile({
            type: 'asset',
            fileName: 'manifest.json',
            source: `${JSON.stringify(manifest, null, 2)}\n`,
          })
        },
        // A content script is a classic script, never a module, so it is its
        // own build: one file, nothing imported at run time.
        async closeBundle() {
          if (!firefox) return
          await build({
            configFile: false,
            logLevel: 'warn',
            build: {
              target: 'es2022',
              outDir,
              emptyOutDir: false,
              minify: false,
              lib: {
                entry: 'src/content.ts',
                formats: ['iife'],
                name: 'whiteboardContent',
                fileName: () => 'content.js',
              },
            },
          })
        },
      },
    ],
  }
})
