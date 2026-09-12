// The lane's REPORT LINE is where a reading is actually taken. A column the
// score computes and the line drops is a measurement nobody sees, and the
// one this file exists for was exactly that: a board that declares no
// construct printed `facets: declares nothing` and stopped, hiding a
// `contested` channel — colour doing work no declaration explains, which
// ADR-0033's axis calls a real defect rather than a clean bill.
import { describe, expect, it } from 'vitest'
import { facetLine } from './report-line.mjs'

/** What `scoreFacets` hands the line, with only the fields the line reads. */
const score = (over: Record<string, unknown>) => ({
  constructs: 0,
  deficit: 0,
  treatments: 0,
  distance: 0,
  overload: 0,
  excess: 0,
  channels: {
    colour: { use: 'unused', carriedBy: [] },
    shape: { use: 'unused', carriedBy: [] },
  },
  ...over,
})

describe('the facet line', () => {
  it('says a board declaring nothing AND spending nothing is silent', () => {
    expect(facetLine(score({}))).toBe('; facets: declares nothing')
  })

  it('reports a contested channel on a board that declares nothing', () => {
    // The whole point of the axis: the board draws a distinction and records
    // none. Silence here reads as a clean bill, and it is the opposite.
    const line = facetLine(
      score({
        channels: {
          colour: { use: 'contested', carriedBy: [] },
          shape: { use: 'unused', carriedBy: [] },
        },
      }),
    )
    expect(line).toContain('colour contested')
    expect(line).toContain('declares nothing')
  })

  it('names what carries a channel, rather than a bare `carried`', () => {
    const line = facetLine(
      score({
        constructs: 6,
        treatments: 6,
        distance: 1,
        channels: {
          colour: { use: 'carried', carriedBy: ['ops.status/v0'] },
          shape: { use: 'carried', carriedBy: ['stencil', 'kind'] },
        },
      }),
    )
    expect(line).toContain('colour carried(ops.status/v0)')
    expect(line).toContain('shape carried(stencil+kind)')
  })

  it('prints deficit over constructs, which is what the first reading is a ratio of', () => {
    expect(facetLine(score({ constructs: 6, deficit: 2, treatments: 1 }))).toContain(
      'facets deficit 2/6, treatments 1',
    )
  })

  it('names overload and excess only when they are owed', () => {
    expect(facetLine(score({ constructs: 6, excess: 3 }))).toContain('excess 3')
    expect(facetLine(score({ constructs: 6 }))).not.toContain('excess')
  })

  it('says nothing at all when the board was not scored', () => {
    expect(facetLine(undefined)).toBe('')
  })
})
