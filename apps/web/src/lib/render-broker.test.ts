import { describe, expect, it, vi } from 'vitest'
import { createInTabRenderBroker } from './render-broker.js'
import { renderKeyOf } from './render-key.js'

const drawn = { svg: '<svg/>', bounds: { x: 0, y: 0, w: 1, h: 1 } }
const keyFor = (documentId: string, updatedAt = '2026-09-03T00:00:00Z') =>
  renderKeyOf({ documentId, kind: 'spatial' as const, updatedAt }, 'light')

/** A producer that does not settle until the test says so. */
function deferred() {
  let release: (value: typeof drawn | null) => void = () => {}
  const promise = new Promise<typeof drawn | null>((resolve) => {
    release = resolve
  })
  return { promise, release: (value: typeof drawn | null = drawn) => release(value) }
}

describe('the in-tab render broker', () => {
  it('produces once per key and answers the second caller from the memo', async () => {
    const produce = vi.fn().mockResolvedValue(drawn)
    const broker = createInTabRenderBroker()
    const key = keyFor('doc-1')

    expect(await broker.render(key, produce)).toEqual(drawn)
    expect(await broker.render(key, produce)).toEqual(drawn)

    expect(produce).toHaveBeenCalledTimes(1)
  })

  // The measured defect: a row's thumbnail and the preview beside it ask
  // independently, and the second arrives while the first is still in the
  // worker. Memoising the RESULT is not enough — the join has to happen while
  // the work is in flight, or the second caller starts a second render.
  it('joins a caller that arrives while the same key is still rendering', async () => {
    const pending = deferred()
    const produce = vi.fn().mockReturnValue(pending.promise)
    const broker = createInTabRenderBroker()
    const key = keyFor('doc-1')

    const first = broker.render(key, produce)
    const second = broker.render(key, produce)
    pending.release()

    expect(await first).toEqual(drawn)
    expect(await second).toEqual(drawn)
    expect(produce).toHaveBeenCalledTimes(1)
  })

  it('keeps different keys apart', async () => {
    const produce = vi.fn().mockResolvedValue(drawn)
    const broker = createInTabRenderBroker()

    await broker.render(keyFor('doc-1'), produce)
    await broker.render(keyFor('doc-2'), produce)

    expect(produce).toHaveBeenCalledTimes(2)
  })

  it('re-renders when a document changes, because the key changed with it', async () => {
    const produce = vi.fn().mockResolvedValue(drawn)
    const broker = createInTabRenderBroker()

    await broker.render(keyFor('doc-1', '2026-09-03T00:00:00Z'), produce)
    await broker.render(keyFor('doc-1', '2026-09-03T01:00:00Z'), produce)

    expect(produce).toHaveBeenCalledTimes(2)
  })

  // A failure must not be remembered as an answer. A row whose fetch failed
  // once keeps its kind icon; it must not keep it for the rest of the session.
  it('does not memoise a rejection', async () => {
    const produce = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(drawn)
    const broker = createInTabRenderBroker()
    const key = keyFor('doc-1')

    await expect(broker.render(key, produce)).rejects.toThrow('offline')
    expect(await broker.render(key, produce)).toEqual(drawn)
    expect(produce).toHaveBeenCalledTimes(2)
  })

  // `null` is this pipeline's "nothing to draw" (an empty body, a failed
  // decode), and it IS an answer — remembering it is what stops an empty note
  // being re-fetched on every scroll.
  it('memoises a null answer', async () => {
    const produce = vi.fn().mockResolvedValue(null)
    const broker = createInTabRenderBroker()
    const key = keyFor('doc-1')

    expect(await broker.render(key, produce)).toBeNull()
    expect(await broker.render(key, produce)).toBeNull()
    expect(produce).toHaveBeenCalledTimes(1)
  })

  it('drops the oldest entries past its cap rather than growing without bound', async () => {
    const produce = vi.fn().mockResolvedValue(drawn)
    const broker = createInTabRenderBroker({ maxEntries: 2 })

    await broker.render(keyFor('doc-1'), produce)
    await broker.render(keyFor('doc-2'), produce)
    await broker.render(keyFor('doc-3'), produce)
    expect(broker.size).toBeLessThanOrEqual(2)

    await broker.render(keyFor('doc-3'), produce)
    expect(produce).toHaveBeenCalledTimes(3)
  })
})
