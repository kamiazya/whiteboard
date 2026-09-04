// Guards over what the smoke script actually DOES, in two directions the
// script cannot check about itself.
//
// The smoke keeps its own copy of the tool list (it is plain .mjs and cannot
// import the TS module), and a comment asking the two to agree is not a
// guard: adding a tool updated one list and left the other, which reads as
// "tools/list does not match expected" long after the edit that caused it.
//
// The second direction is finer than the tool. Coverage here is recorded per
// TOOL, and what the MCP SDK validates at runtime is per OUTPUT SHAPE — so a
// tool whose output is partitioned by a discriminator can sit in
// COVERED_TOOLS, truthfully, with some of its shapes never produced. That is
// not hypothetical: `wb_version_restore` was COVERED with only one of its
// three modes reached, and renaming a field on either of the other two left
// `pnpm smoke:e2e` green.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { versionRestoreOutputSchema } from '@kamiazya/whiteboard-server-core'
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

// `wb_version_restore` is the repo's ONLY tool whose output schema carries a
// discriminator that partitions the output into distinct shapes — measured
// across every registered tool, not assumed. `deleted`/`imported` are
// constants and thread-edit's `status` is a data field, none of them naming
// a second shape. So this is a rule about one surface rather than a table
// over many, per `.claude/rules/coverage-ledger.md`: a scan generalized from
// a single instance is how a convention gets made by accident.
//
// The modes are read from the SCHEMA, so adding a fourth fails here until
// the smoke produces it. A hand-written list beside the enum would be the
// same drift one level up.
describe('the smoke script produces every restore output shape', () => {
  const MODES = versionRestoreOutputSchema.shape.mode.options

  // Comments are stripped first. This file's own history is the reason: the
  // smoke's prose names all three modes while its assertions name fewer, so
  // a raw scan would report full coverage from the comments alone — the
  // "strip comments before matching" lesson `coverage-ledger.md` records.
  const executable = smokeSource
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  const asserted = new Set(
    [...executable.matchAll(/\.mode !== '([a-z-]+)'/g)].map((match) => match[1]),
  )

  it('found a plausible number of mode assertions (scan sanity, not vacuous)', () => {
    // Without this, a regex that matched nothing would make every assertion
    // below read as "the smoke covers no mode", which is a different and
    // far more alarming failure than the one that is real.
    expect(asserted.size).toBeGreaterThan(0)
  })

  it.each(MODES)('asserts mode === %s', (mode) => {
    expect(
      asserted.has(mode),
      `wb_version_restore can answer mode: '${mode}' and the smoke never asserts it — that shape's structuredContent is never validated at runtime`,
    ).toBe(true)
  })

  it('asserts no mode the schema cannot answer', () => {
    expect([...asserted].sort()).toEqual([...MODES].sort())
  })
})
