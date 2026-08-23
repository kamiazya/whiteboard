// The smoke script keeps its own copy of the tool list (it is plain .mjs and
// cannot import the TS module), and a comment asking the two to agree is not
// a guard: adding a tool updated one list and left the other, which reads as
// "tools/list does not match expected" long after the edit that caused it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'

const smokeSource = readFileSync(
  fileURLToPath(new URL('../../../scripts/smoke/mcp-e2e-smoke.mjs', import.meta.url)),
  'utf8',
)

describe('the smoke script and the coverage module name the same tools', () => {
  it('EXPECTED_TOOLS matches ALL_REGISTERED_TOOLS', () => {
    const block = /const EXPECTED_TOOLS = \[([\s\S]*?)\]/.exec(smokeSource)?.[1]
    expect(block, 'EXPECTED_TOOLS not found in the smoke script').toBeDefined()
    const inSmoke = [...(block ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort()
    expect(inSmoke).toEqual([...ALL_REGISTERED_TOOLS].sort())
  })
})
