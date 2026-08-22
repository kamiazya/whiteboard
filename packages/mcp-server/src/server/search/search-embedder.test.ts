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

  it('is absent for any value other than the documented opt-in', () => {
    for (const value of ['', '0', 'true', 'yes']) {
      process.env[FLAG] = value
      expect(resolveSearchEmbedder(), value).toBeUndefined()
    }
  })

  it('opts in with the documented value, without loading a model yet', () => {
    process.env[FLAG] = '1'
    const embedder = resolveSearchEmbedder()
    expect(embedder?.dimensions).toBe(384)
  })

  it('answers with ONE embedder across calls, so the model is loaded once', () => {
    // /mcp is stateless per request: the MCP server, and with it every
    // ServerDeps, is rebuilt for each call. A per-call embedder would
    // re-load ~113MB of weights on every single search.
    process.env[FLAG] = '1'
    expect(resolveSearchEmbedder()).toBe(resolveSearchEmbedder())
  })
})
