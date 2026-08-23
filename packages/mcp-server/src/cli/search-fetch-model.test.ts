import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MODEL,
  EMBEDDER_LOAD_REMEDY,
  EMBEDDING_DIMENSIONS,
} from '../server/search/transformers-embedder.js'
import { runSearchFetchModel } from './search-fetch-model.js'

const pipeline = vi.hoisted(() => vi.fn())
const env = vi.hoisted(() => ({ cacheDir: '', allowRemoteModels: true }))

vi.mock('@huggingface/transformers', () => ({ pipeline, env }))

function extractorOfWidth(width: number) {
  return vi.fn(async () => ({ data: new Float32Array(width) }))
}

describe('runSearchFetchModel', () => {
  it('reports the fetched model once an embedding of the right width comes back', async () => {
    pipeline.mockResolvedValue(extractorOfWidth(EMBEDDING_DIMENSIONS))

    const { result, exitCode } = await runSearchFetchModel({ cacheDir: '/data/models' })

    expect(exitCode).toBe(0)
    expect(result).toMatchObject({
      ok: true,
      cacheDir: '/data/models',
      model: DEFAULT_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
    })
  })

  it('downloads rather than running offline — being the download is the point', async () => {
    env.allowRemoteModels = true
    pipeline.mockResolvedValue(extractorOfWidth(EMBEDDING_DIMENSIONS))

    await runSearchFetchModel({ cacheDir: '/data/models' })

    expect(env.allowRemoteModels).toBe(true)
    expect(env.cacheDir).toBe('/data/models')
  })

  it('names the install step when the optional runtime is not there', async () => {
    pipeline.mockRejectedValue(
      Object.assign(new Error("Cannot find package '@huggingface/transformers'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      }),
    )

    const { result, exitCode } = await runSearchFetchModel({ cacheDir: '/data/models' })

    expect(exitCode).toBe(1)
    expect(result).toMatchObject({
      ok: false,
      failure: 'runtime-missing',
      remedy: EMBEDDER_LOAD_REMEDY['runtime-missing'],
    })
  })

  // A cache left over from a different model loads fine and answers at the
  // wrong width. Reporting success there is worse than failing: the daemon
  // then rejects every vector and silently serves lexical results.
  it('fails when the model loads but answers at the wrong width', async () => {
    pipeline.mockResolvedValue(extractorOfWidth(EMBEDDING_DIMENSIONS + 1))

    const { result, exitCode } = await runSearchFetchModel({ cacheDir: '/data/models' })

    expect(exitCode).toBe(1)
    expect(result).toMatchObject({ ok: false, failure: 'unexpected-dimensions' })
  })
})

describe('runSearchFetchModel diagnostics', () => {
  // Measured against a real run: a proxy that blocks huggingface.co produces
  // `load-failed`, whose remedy is by construction generic. Without the
  // underlying message the user is told only that it failed.
  it('carries the underlying reason for a failure it cannot name', async () => {
    pipeline.mockRejectedValue(new Error('CONNECT tunnel failed, response 403\nat somewhere'))

    const { result } = await runSearchFetchModel({ cacheDir: '/data/models' })

    expect(result).toMatchObject({ ok: false, failure: 'load-failed' })
    expect(result.ok === false && result.detail).toContain('CONNECT tunnel failed')
  })

  it('does not paste a raw path or token into the reason it prints', async () => {
    pipeline.mockRejectedValue(new Error('failed opening /home/someone/.whiteboard/models/x.onnx'))

    const { result } = await runSearchFetchModel({ cacheDir: '/data/models' })

    expect(result.ok === false && result.detail).not.toContain('/home/someone')
  })
})
