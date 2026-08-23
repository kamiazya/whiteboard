import { afterEach, describe, expect, it } from 'vitest'
import { resetSearchEmbedderForTests, resolveSearchEmbedder } from './search-embedder.js'

const FLAG = 'WHITEBOARD_SEMANTIC_SEARCH'

afterEach(() => {
  delete process.env[FLAG]
  resetSearchEmbedderForTests()
})

describe('resolveSearchEmbedder', () => {
  it('is absent by default, so search stays lexical and nothing is downloaded', () => {
    expect(resolveSearchEmbedder()).toBeUndefined()
  })

  it('opts in with the documented value, without loading a model yet', () => {
    process.env[FLAG] = '1'
    const embedder = resolveSearchEmbedder()
    expect(embedder?.dimensions).toBe(384)
  })

  it('defaults to the small weights, and says so in the embedder identity', () => {
    process.env[FLAG] = '1'
    expect(resolveSearchEmbedder()?.id).toBe('Xenova/multilingual-e5-small@q8')
  })

  it('takes full precision when asked for it', () => {
    // Measured on JQaRA: full precision scores 0.051 higher (95% CI
    // [+0.024, +0.081], p = 0.0003) for four times the download. Which
    // side of that a reader wants is theirs to decide, not ours.
    process.env[FLAG] = 'full'
    expect(resolveSearchEmbedder()?.id).toBe('Xenova/multilingual-e5-small@fp32')
  })

  it('is still off for anything that is neither opt-in value', () => {
    for (const value of ['', '0', 'true', 'q8', 'fp32', 'yes']) {
      process.env[FLAG] = value
      expect(resolveSearchEmbedder(), value).toBeUndefined()
    }
  })

  it('answers with ONE embedder across calls, so the model is loaded once', () => {
    // /mcp is stateless per request: the MCP server, and with it every
    // ServerDeps, is rebuilt for each call. A per-call embedder would
    // re-load ~113MB of weights on every single search.
    process.env[FLAG] = '1'
    expect(resolveSearchEmbedder()).toBe(resolveSearchEmbedder())
  })
})
