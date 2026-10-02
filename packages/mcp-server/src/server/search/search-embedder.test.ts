import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSearchEmbedderForTests, resolveSearchEmbedder } from './search-embedder.js'
import { createTransformersEmbedder } from './transformers-embedder.js'

vi.mock('./transformers-embedder.js', async (importActual) => {
  const actual = await importActual<typeof import('./transformers-embedder.js')>()
  return { ...actual, createTransformersEmbedder: vi.fn(actual.createTransformersEmbedder) }
})

const DIR = '/srv/whiteboard-a'

const FLAG = 'WHITEBOARD_SEMANTIC_SEARCH'

afterEach(() => {
  delete process.env[FLAG]
  resetSearchEmbedderForTests()
})

describe('resolveSearchEmbedder', () => {
  it('is absent by default, so search stays lexical and nothing is downloaded', () => {
    expect(resolveSearchEmbedder(DIR)).toBeUndefined()
  })

  it('opts in with the documented value, without loading a model yet', () => {
    process.env[FLAG] = '1'
    const embedder = resolveSearchEmbedder(DIR)
    expect(embedder?.dimensions).toBe(384)
  })

  it('defaults to the small weights, and says so in the embedder identity', () => {
    process.env[FLAG] = '1'
    expect(resolveSearchEmbedder(DIR)?.id).toBe('Xenova/multilingual-e5-small@q8')
  })

  it('takes full precision when asked for it', () => {
    // Measured on JQaRA: full precision scores 0.051 higher (95% CI
    // [+0.024, +0.081], p = 0.0003) for four times the download. Which
    // side of that a reader wants is theirs to decide, not ours.
    process.env[FLAG] = 'full'
    expect(resolveSearchEmbedder(DIR)?.id).toBe('Xenova/multilingual-e5-small@fp32')
  })

  it('is still off for anything that is neither opt-in value', () => {
    for (const value of ['', '0', 'true', 'q8', 'fp32', 'yes']) {
      process.env[FLAG] = value
      expect(resolveSearchEmbedder(DIR), value).toBeUndefined()
    }
  })

  it('answers with ONE embedder across calls, so the model is loaded once', () => {
    // /mcp is stateless per request: the MCP server, and with it every
    // ServerDeps, is rebuilt for each call. A per-call embedder would
    // re-load ~113MB of weights on every single search.
    process.env[FLAG] = '1'
    expect(resolveSearchEmbedder(DIR)).toBe(resolveSearchEmbedder(DIR))
  })

  it('reads the weights from the directory it is handed, one embedder per directory', () => {
    process.env[FLAG] = '1'
    const other = '/srv/whiteboard-b'

    expect(resolveSearchEmbedder(other)).not.toBe(resolveSearchEmbedder(DIR))
    expect(createTransformersEmbedder).toHaveBeenCalledWith(
      expect.objectContaining({ cacheDir: join(other, 'models') }),
    )
    expect(createTransformersEmbedder).toHaveBeenCalledWith(
      expect.objectContaining({ cacheDir: join(DIR, 'models') }),
    )
  })
})
