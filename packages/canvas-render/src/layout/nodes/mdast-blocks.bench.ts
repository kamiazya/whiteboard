import { bench, describe } from 'vitest'
import {
  CORPUS_WIDTHS_PX,
  createCorpusMeasure,
  TEXT_WRAPPING_CORPUS,
} from '../../test-utils/text-wrapping-corpus.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

/**
 * Prices line breaking on the same corpus the scoreboard scores. Text layout
 * runs on the editor's drag path, so a breaking strategy that fits every line
 * by measuring far more often has to show what that costs in time, not only
 * in the scoreboard's `measure` count.
 */
describe('layoutMdastBlocks', () => {
  const measure = createCorpusMeasure().measure

  bench('corpus x widths', () => {
    for (const entry of TEXT_WRAPPING_CORPUS) {
      for (const maxWidth of CORPUS_WIDTHS_PX) {
        layoutMdastBlocks(entry.root, { measure, maxWidth, fontFamily: 'Roboto' })
      }
    }
  })
})
