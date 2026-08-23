import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type CapturedLogsHandle, captureLogsForTests } from '../log.js'
import {
  classifyEmbedderLoadFailure,
  createTransformersEmbedder,
  DEFAULT_MODEL,
  EMBEDDER_LOAD_REMEDY,
} from './transformers-embedder.js'

const pipeline = vi.hoisted(() => vi.fn())
const env = vi.hoisted(() => ({ cacheDir: '', allowRemoteModels: true }))

vi.mock('@huggingface/transformers', () => ({ pipeline, env }))

/** Two 3-wide unit-ish vectors laid end to end, the shape the runtime returns. */
function extractorReturning(data: number[]) {
  return vi.fn(async () => ({ data: Float32Array.from(data) }))
}

describe('createTransformersEmbedder', () => {
  let logs: CapturedLogsHandle

  beforeEach(() => {
    vi.clearAllMocks()
    env.cacheDir = ''
    env.allowRemoteModels = true
    logs = captureLogsForTests('debug')
  })

  afterEach(() => {
    logs.restore()
  })

  it('prefixes queries and documents with the literal strings e5 was trained on', async () => {
    const extractor = extractorReturning([1, 0, 0])
    pipeline.mockResolvedValue(extractor)
    const embedder = createTransformersEmbedder({ cacheDir: '/tmp/cache' })

    await embedder.embed(['reconnect'], 'query')
    expect(extractor).toHaveBeenCalledWith(['query: reconnect'], expect.anything())

    await embedder.embed(['reconnect'], 'document')
    expect(extractor).toHaveBeenLastCalledWith(['passage: reconnect'], expect.anything())
  })

  it('slices one vector per input out of the flat tensor the runtime returns', async () => {
    pipeline.mockResolvedValue(extractorReturning([1, 2, 3, 4, 5, 6]))
    const embedder = createTransformersEmbedder({ cacheDir: '/tmp/cache' })

    const vectors = await embedder.embed(['a', 'b'], 'document')

    expect(vectors).toHaveLength(2)
    expect([...(vectors[0] ?? [])]).toEqual([1, 2, 3])
    expect([...(vectors[1] ?? [])]).toEqual([4, 5, 6])
  })

  it('points the runtime at the caller-supplied cache dir instead of node_modules', async () => {
    pipeline.mockResolvedValue(extractorReturning([1, 0, 0]))
    await createTransformersEmbedder({ cacheDir: '/data/models' }).embed(['x'], 'document')
    expect(env.cacheDir).toBe('/data/models')
  })

  it('forbids remote fetches only when the caller asks for offline', async () => {
    pipeline.mockResolvedValue(extractorReturning([1, 0, 0]))

    await createTransformersEmbedder({ cacheDir: '/c', offline: true }).embed(['x'], 'document')
    expect(env.allowRemoteModels).toBe(false)

    env.allowRemoteModels = true
    await createTransformersEmbedder({ cacheDir: '/c' }).embed(['x'], 'document')
    expect(env.allowRemoteModels).toBe(true)
  })

  it('remembers a load failure instead of retrying the model on every query', async () => {
    pipeline.mockRejectedValue(new Error('no weights here'))
    const embedder = createTransformersEmbedder({ cacheDir: '/c' })

    expect(await embedder.embed(['a'], 'query')).toEqual([])
    expect(await embedder.embed(['b'], 'query')).toEqual([])

    expect(pipeline).toHaveBeenCalledTimes(1)
  })

  it('logs the remedy for the specific failure rather than a bare "unavailable"', async () => {
    pipeline.mockRejectedValue(
      Object.assign(new Error("Cannot find package '@huggingface/transformers'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      }),
    )

    await createTransformersEmbedder({ cacheDir: '/c' }).embed(['a'], 'query')

    const warned = logs.records.find((record) => record.level === 'warning')
    expect(warned?.data?.failure).toBe('runtime-missing')
    expect(warned?.msg).toContain(EMBEDDER_LOAD_REMEDY['runtime-missing'])
  })

  it('does not load the model at construction, nor for an empty batch', async () => {
    pipeline.mockResolvedValue(extractorReturning([1, 0, 0]))
    const embedder = createTransformersEmbedder({ cacheDir: '/c' })
    expect(pipeline).not.toHaveBeenCalled()

    expect(await embedder.embed([], 'query')).toEqual([])
    expect(pipeline).not.toHaveBeenCalled()
  })

  it('loads the default multilingual model when the caller names none', async () => {
    pipeline.mockResolvedValue(extractorReturning([1, 0, 0]))
    await createTransformersEmbedder({ cacheDir: '/c' }).embed(['x'], 'document')
    expect(pipeline).toHaveBeenCalledWith('feature-extraction', DEFAULT_MODEL, { dtype: 'q8' })
  })
})

describe('classifyEmbedderLoadFailure', () => {
  // The two failures need different advice and are indistinguishable in the
  // log line they used to share: one is fixed by installing a package, the
  // other by fetching weights. Reporting "unavailable" for both is how an
  // opt-in flag ends up quietly doing nothing.
  it.each([
    'ERR_MODULE_NOT_FOUND',
    'MODULE_NOT_FOUND',
  ])('reads %s as the optional runtime not being installed', (code) => {
    const err = Object.assign(new Error("Cannot find package '@huggingface/transformers'"), {
      code,
    })
    expect(classifyEmbedderLoadFailure(err)).toBe('runtime-missing')
  })

  it('reads an offline miss as weights that have not been fetched yet', () => {
    const err = new Error('Could not locate file: "https://huggingface.co/…/model_quantized.onnx"')
    expect(classifyEmbedderLoadFailure(err)).toBe('weights-missing')
  })

  it('does not guess at an unrecognised failure', () => {
    expect(classifyEmbedderLoadFailure(new Error('onnx session init segfaulted'))).toBe(
      'load-failed',
    )
  })
})
