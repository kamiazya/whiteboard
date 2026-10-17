// What one document contributes to the index, counted. The daemon searches a
// whole workspace per call and a body may be MARKDOWN_MAX_CHARS long, so the
// size of one document's terms is multiplied by the workspace's document
// ceiling — counted rather than heap-measured, because a count is the same on
// every machine and a heap figure is not.

import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { documentTerms } from './full-text.js'
import { randomCjk } from './test-utils/random-cjk.js'

describe('documentTerms size', () => {
  it('indexes a maximal random-CJK body as one unigram and one bigram per character', () => {
    const terms = documentTerms({ path: 'd', texts: [randomCjk(MARKDOWN_MAX_CHARS)] })
    // The path's one latin token, every character, every adjacent pair.
    expect(terms.length).toBe(1 + MARKDOWN_MAX_CHARS + (MARKDOWN_MAX_CHARS - 1))
    // Almost every bigram is distinct: about 283,000 keys for one document.
    expect(terms.counts.size).toBeGreaterThan(250_000)
  })
})
