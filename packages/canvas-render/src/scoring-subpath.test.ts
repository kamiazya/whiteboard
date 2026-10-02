// The quality instruments (drawing, composition, facet scores) are read by the
// tool-surface eval lane and by this package's own tests, and by nothing that
// ships to a user. They are ~1.5k lines, so they live on a `/scoring` subpath:
// the main barrel is what the layout worker, the web editor and the daemon
// import, and a symbol exported from it is part of every one of those graphs'
// public surface whether or not anything reads it.
//
// `scoreFacets` is also used INSIDE the package by `legend/canvas-legend.ts`,
// by a relative import. That is why leaving the barrel is a surface change and
// not a size one: the module still ships with the legend.
import { describe, expect, it } from 'vitest'
import manifestSource from '../package.json?raw'
import * as barrel from './index.js'
import * as scoring from './scoring.js'

const SCORING_EXPORTS = [
  'EVEN_GAP_TOLERANCE_PX',
  'GROUP_PADDING_PX',
  'NEAR_MISS_PX',
  'scoreComposition',
  'scoreDrawing',
  'scoreFacets',
] as const

describe('the scoring subpath', () => {
  it('is declared in the manifest, pointing at the module that holds the scorers', () => {
    const manifest = JSON.parse(manifestSource) as {
      exports: Record<string, { import?: string }>
    }
    expect(manifest.exports['./scoring']?.import).toBe('./src/scoring.ts')
  })

  it('exports every scorer, so an empty module does not satisfy the barrel check below', () => {
    expect(Object.keys(scoring).sort()).toEqual([...SCORING_EXPORTS].sort())
  })

  it('is absent from the main barrel', () => {
    const leaked = SCORING_EXPORTS.filter((name) => name in barrel)
    expect(leaked).toEqual([])
  })
})
