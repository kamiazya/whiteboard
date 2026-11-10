/**
 * The facet engine's interpreter reads the contract files themselves, so a
 * contract it cannot compile is a payload judged by a schema with a rule
 * missing. `crates/core/plugin-visual/tests/contract_drift.rs` compiles each
 * contract file the repository ships; it reads them through `include_str!`,
 * which a new file does not join by itself, so this holds the list to the
 * directory from the other side.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, walk } from './scan-roots.js'

const DRIFT_TEST = 'crates/core/plugin-visual/tests/contract_drift.rs'

describe('the contract drift test', () => {
  const contracts = walk(join(REPO_ROOT, 'contracts'), {
    include: (path) => path.endsWith('.schema.json'),
  }).map((path) => relative(REPO_ROOT, path).replaceAll('\\', '/'))
  const source = readFileSync(join(REPO_ROOT, DRIFT_TEST), 'utf8')

  it('finds the contracts the repository ships', () => {
    expect(contracts.length).toBeGreaterThan(5)
  })

  it('compiles every one of them', () => {
    const unread = contracts.filter((path) => !source.includes(`../../../../${path}`))
    expect(unread, `contract files ${DRIFT_TEST} does not include`).toEqual([])
  })
})
