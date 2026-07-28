import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The package root is the directory holding this package's package.json and its
// dist/ tree — both under tsx (src) and node (built dist), and after npm publish
// (node_modules/@kamiazya/whiteboard-mcp).
//
// It is resolved by walking up from the caller's module URL to the nearest
// package.json rather than a fixed `../..` offset, because the bundler (esbuild
// code splitting) can hoist a module's body into a chunk at the dist root whose
// depth differs from the original source file — a fixed relative offset would
// then resolve to the wrong directory. Walking up to package.json is depth- and
// bundle-location-independent.
export function findPackageRoot(fromModuleUrl: string): string {
  const start = dirname(fileURLToPath(fromModuleUrl))
  let dir = start
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      // Reached the filesystem root without finding package.json. Fall back to
      // the legacy dist/shared layout offset so behavior degrades predictably.
      return resolve(start, '../..')
    }
    dir = parent
  }
}
