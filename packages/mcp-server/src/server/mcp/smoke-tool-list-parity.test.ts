// The smoke script keeps its own copy of the tool list (it is plain .mjs and
// cannot import the TS module), and a comment asking the two to agree is not
// a guard: adding a tool updated one list and left the other, which reads as
// "tools/list does not match expected" long after the edit that caused it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALL_REGISTERED_TOOLS,
  COVERED_TOOLS,
  DEFERRED_TOOLS,
  UNIT_ONLY_TOOLS,
} from './mcp-smoke-coverage.js'

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

// The COVERED_TOOLS / UNIT_ONLY_TOOLS / DEFERRED_TOOLS split is a claim about
// what the smoke script actually DOES, not just a second list that agrees
// with itself — a tool can be misclassified as COVERED while the smoke
// never calls it (or vice versa) without either array's own consistency
// checks catching it. wb_body_patch shipped exactly that way: registered
// with a schema that rejected every payload, correctly absent from any
// success-path test, but marked UNIT_ONLY rather than the smoke calling it.
describe('the smoke script really calls what COVERED_TOOLS claims', () => {
  const calledSet = new Set(
    [...smokeSource.matchAll(/callTool\(\s*'([a-z_]+)'/g)].map((match) => match[1]),
  )

  it('found a plausible number of distinct callTool(...) names (scan sanity, not vacuous)', () => {
    // A regex or path that silently matched nothing would make the
    // disjointness assertion below pass by finding no names at all — this
    // floor is what turns that into a failure instead of a false green.
    expect(calledSet.size).toBeGreaterThanOrEqual(COVERED_TOOLS.length)
  })

  it.each(COVERED_TOOLS)('%s is called via callTool(...) in the smoke script', (name) => {
    expect(calledSet.has(name), `${name} is in COVERED_TOOLS but the smoke never calls it`).toBe(
      true,
    )
  })

  it.each([
    ...UNIT_ONLY_TOOLS,
    ...DEFERRED_TOOLS.map((tool) => tool.name),
  ])('%s is NOT called via callTool(...) in the smoke script', (name) => {
    expect(
      calledSet.has(name),
      `${name} is classified UNIT_ONLY/DEFERRED but the smoke calls it — move it to COVERED_TOOLS`,
    ).toBe(false)
  })
})
