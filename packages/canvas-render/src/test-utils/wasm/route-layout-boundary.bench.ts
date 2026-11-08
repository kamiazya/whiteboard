import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import { test } from 'vitest'
import type { LayoutCore } from '../../layout/edges/layout-core.js'
import { boundaryBoards, routeBoard } from './route-layout-boundary.js'

/**
 * `routeLayout` per size class, the TypeScript against the Rust core through
 * its shim, in one process (QR-22b). Runs under `canvas-render-node (bench)`,
 * where no alias replaces `edge-router`/`spatial-edges`/`grid-route`, so the
 * TypeScript side is the TypeScript. The split of the Rust side into boundary
 * and routing, and the browser and worker runs, are
 * `scripts/route-layout-boundary.mjs`.
 *
 * Needs `pnpm rust:build:wasm` and `pnpm --filter @kamiazya/whiteboard-core-wasm
 * stage:wasm`; without the artifact the cases are skipped.
 */
// The package's own `./wasm` export, so no path leaves this workspace; it
// resolves to nothing until the artifact is staged.
const wasm = (() => {
  try {
    return createRequire(import.meta.url).resolve('@kamiazya/whiteboard-core-wasm/wasm')
  } catch {
    return undefined
  }
})()
const staged = wasm !== undefined
const rust: LayoutCore | undefined = staged
  ? { routing: await loadCore(readFileSync(wasm as string)), impl: { routeLayout: 'rust' } }
  : undefined

for (const board of boundaryBoards()) {
  test.runIf(staged)(`routeLayout, ${board.name}`, { timeout: 0 }, async ({ bench }) => {
    await bench.compare(
      bench('TypeScript', () => routeBoard(undefined, board, 'straight')),
      bench('Rust via core-wasm', () => routeBoard(rust, board, 'straight')),
    )
  })
}
