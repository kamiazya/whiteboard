// Stryker silently ignores a `mutate` entry that matches no file, so a target
// list is a set of claims about which modules are mutation-covered that
// nothing checks.
//
// Three of the thirteen entries here named files that had been renamed or
// deleted — `api-contracts/libraries.ts` (the whole user-libraries feature
// was removed), `routes/canvas-thumbnail.ts` and
// `routes/canvas-output-path-error.ts`. The run stayed green and the score
// stayed plausible; it was simply computed over ten modules while the list
// said thirteen.
//
// `canvas-render` already guards its own list this way. This is that guard,
// ported.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const PACKAGE_ROOT = resolve(REPO_ROOT, 'packages/mcp-server')
const config = readFileSync(resolve(PACKAGE_ROOT, 'stryker.config.mjs'), 'utf-8')

/** The `mutate` array's entries, in source order. */
function mutateTargets(): string[] {
  const block = /mutate:\s*\[([\s\S]*?)\]/.exec(config)?.[1]
  if (block === undefined) throw new Error('stryker.config.mjs has no mutate array')
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '')
}

describe('stryker mutate targets', () => {
  it('name files that exist', () => {
    const missing = mutateTargets().filter((target) => !existsSync(resolve(PACKAGE_ROOT, target)))
    expect(missing).toEqual([])
  })

  /**
   * Reached, not assumed — an empty or unparsed list would satisfy the check
   * above without looking at anything.
   */
  it('are a plausible list', () => {
    expect(mutateTargets().length).toBeGreaterThan(5)
  })
})
