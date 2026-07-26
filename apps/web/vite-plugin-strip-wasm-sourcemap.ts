import type { Plugin } from 'vite'
import { stripWasmSourceMap } from './scripts/strip-wasm-sourcemap.js'

/**
 * Strips the `sourceMappingURL` custom section from every emitted `.wasm`
 * asset (loro-crdt's bundler build points it at an unpkg.com URL, which
 * DevTools-open sessions fetch and our CSP's connect-src then blocks).
 *
 * Must run in `generateBundle`, and must be registered BEFORE `VitePWA` in
 * the plugins array: `VitePWA` computes its precache manifest revisions in
 * `closeBundle` by globbing the files already written to `dist/`, so the
 * asset bytes have to be final (stripped) before that hook runs. Mutating
 * `dist/` after the build (a post-build script) would leave the precache
 * manifest's revision hash pointing at the pre-strip bytes.
 */
export function stripWasmSourceMapPlugin(): Plugin {
  return {
    name: 'strip-wasm-sourcemap',
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset' || !asset.fileName.endsWith('.wasm')) continue
        const source = asset.source
        // A string source for a binary asset is a latin1 (one-char-per-byte)
        // representation; TextEncoder would UTF-8-re-encode bytes >= 0x80 into
        // multi-byte sequences and corrupt the wasm. Decode as latin1 so each
        // byte round-trips.
        const bytes =
          typeof source === 'string' ? Buffer.from(source, 'latin1') : new Uint8Array(source)
        asset.source = Buffer.from(stripWasmSourceMap(bytes))
      }
    },
  }
}
