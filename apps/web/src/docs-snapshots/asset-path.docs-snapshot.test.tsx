/**
 * Where a docs snapshot lands, asserted from the browser side.
 *
 * Every snapshot test here reports "passed" when `page.screenshot` resolves,
 * and `page.screenshot` resolves for ANY path it can `mkdir -p` its way to.
 * So a wrong `__DOCS_ASSETS_DIR__` is not a red test: it is eight green
 * tests and eight PNGs written somewhere nobody looks, while `docs/assets/`
 * keeps the old images. Measured: a value that arrived as the JSON text
 * `"/home/.../docs/assets"` (quotes included) produced a directory literally
 * named `"` under `src/docs-snapshots/`, and the run reported 8 passed.
 *
 * CI does not run this project, so nothing downstream would have noticed
 * either. This is the one assertion that reads the path instead of the exit
 * code.
 */

import { expect, it } from 'vitest'
import { resolveDocAssetPath } from './_helpers.js'

it('resolves a docs asset to an absolute, unquoted path under docs/assets', () => {
  const path = resolveDocAssetPath('probe.png')
  expect(path).not.toContain('"')
  expect(path.startsWith('/')).toBe(true)
  expect(path.endsWith('/docs/assets/probe.png')).toBe(true)
})
