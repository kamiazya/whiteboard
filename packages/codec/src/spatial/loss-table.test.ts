// The committed table under docs/reference/ is the published half of
// ADR-0037 decision 2; this file-snapshot test holds it byte-equal to what the
// ledger generates (CI fails on drift). Regenerate deliberately with:
//   pnpm vitest run --project codec-node loss-table -u

import { describe, expect, it } from 'vitest'
import { censusSpatialModel } from './census.js'
import { jsonCanvasLossTable, ocifLossTable } from './loss-table.js'
import { OCIF_PROJECTION } from './ocif-projection.js'
import { JSON_CANVAS_PROJECTION, jsonCanvasLoss } from './projection.js'

describe('the published JSON Canvas loss table', () => {
  it('docs/reference/json-canvas-loss.md matches the ledger', async () => {
    await expect(jsonCanvasLossTable()).toMatchFileSnapshot(
      '../../../../docs/reference/json-canvas-loss.md',
    )
  })

  it('names every position the model can hold, and no other', () => {
    // The snapshot above would happily record a table that quietly stopped
    // listing half the model — it only says the file equals the function.
    // This is what says the function covers the census.
    const census = censusSpatialModel([])
    const table = jsonCanvasLossTable()
    for (const path of [...census.paths, ...census.facetBuckets]) {
      expect(table).toContain(`\`${path}\``)
    }
    const listed = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1])
    expect([...listed].sort()).toEqual([...census.paths, ...census.facetBuckets].sort())
  })

  it('gives every lossy row a reason a reader can act on', () => {
    // `extension` says the same thing every time (strict drops the key), so
    // the rows that owe a real sentence are the other two — the ones where a
    // reader gets something ELSE rather than nothing.
    const table = jsonCanvasLossTable()
    for (const entry of jsonCanvasLoss()) {
      if (entry.projection.kind === 'degraded') expect(table).toContain(entry.projection.to)
      if (entry.projection.kind === 'dropped') expect(table).toContain(entry.projection.why)
    }
  })

  it('counts the surviving half from the ledger rather than from a literal', () => {
    // A headline number written by hand is the first thing to go stale, and it
    // is the only part of this page most readers will quote.
    const kinds = Object.values(JSON_CANVAS_PROJECTION).map((projection) => projection.kind)
    const surviving = kinds.filter((kind) => kind === 'native' || kind === 'degraded').length
    expect(jsonCanvasLossTable()).toContain(
      `**${kinds.length}** field positions. **${surviving}** of them`,
    )
  })
})

describe('the published OCIF loss table', () => {
  it('docs/reference/ocif-loss.md matches the ledger', async () => {
    await expect(ocifLossTable()).toMatchFileSnapshot('../../../../docs/reference/ocif-loss.md')
  })

  it('names every position the model can hold, and no other', () => {
    const census = censusSpatialModel([])
    const table = ocifLossTable()
    const listed = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1])
    expect([...listed].sort()).toEqual([...census.paths, ...census.facetBuckets].sort())
  })

  it('gives every lossy row a reason a reader can act on', () => {
    const table = ocifLossTable()
    for (const projection of Object.values(OCIF_PROJECTION)) {
      if (projection.kind === 'degraded') expect(table).toContain(projection.to)
      if (projection.kind === 'dropped') expect(table).toContain(projection.why)
    }
  })

  it('counts the understood half from the ledger rather than from a literal', () => {
    const kinds = Object.values(OCIF_PROJECTION).map((projection) => projection.kind)
    const understood = kinds.filter((kind) => kind === 'native' || kind === 'degraded').length
    expect(ocifLossTable()).toContain(
      `**${kinds.length}** field positions. **${understood}** of them`,
    )
  })

  it('says nothing is dropped only while nothing is', () => {
    // The headline sentence is a CLAIM about the ledger, not decoration, and it
    // is the one a reader will quote when choosing a format. A position that
    // becomes `dropped` has to change the prose, not merely add a row to a
    // section nobody reads.
    const dropped = Object.values(OCIF_PROJECTION).filter(
      (projection) => projection.kind === 'dropped',
    )
    expect(ocifLossTable().includes('**Nothing is dropped**')).toBe(dropped.length === 0)
  })
})
