// `dist/web-app` and `dist/widget` are NOT tsdown's output: apps/web's
// postbuild copies the first in, and this package's own build copies the
// second after tsdown has run. apps/web has no dependency on this package, so
// `pnpm -r build` builds the two concurrently and no workspace order puts the
// copy after the clean. `clean: true` therefore deletes the web app whenever
// this package happens to finish second — and does so on every standalone
// `pnpm --filter @kamiazya/whiteboard-mcp build` too, which no ordering of the
// root build could cover.
//
// What stays true whichever order the producers finish in is that tsdown only
// cleans what it writes, so the config says that. `prepack`'s
// verify-web-app-dist is the late catch; this is the early one.

import { describe, expect, it } from 'vitest'
import tsdownConfig from '../../../tsdown.config.js'

describe('tsdown clean leaves what other build steps copy into dist', () => {
  const config = Array.isArray(tsdownConfig) ? tsdownConfig[0] : tsdownConfig
  const clean = (config as { clean?: unknown }).clean

  it('cleans by glob rather than the whole outDir', () => {
    expect(Array.isArray(clean), '`clean: true` wipes dist/web-app on every rebuild').toBe(true)
    expect(clean).toContain('dist/**')
  })

  it.each(['dist/web-app', 'dist/widget'])('exempts %s from the clean', (dir) => {
    expect(clean).toContain(`!${dir}/**`)
  })
})
