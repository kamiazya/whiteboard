import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCrdtEngine } from './engine.js'

/**
 * Which clock decides how many undo steps a run of writes makes. Loro's undo
 * manager reads the JavaScript clock (`Date`), so vitest's fake timers move
 * the merge window exactly as they move a debounce: a host that tests its
 * undo steps with a controlled clock gets the same answer the wall clock
 * would give. A write merges into the previous step only when it comes
 * strictly less than the interval after it.
 */

type Engine = ReturnType<typeof createCrdtEngine>

function openTyped(undoMergeIntervalMs?: number) {
  const engine = createCrdtEngine()
  const { handle } = engine.open({
    peer: '1',
    ...(undoMergeIntervalMs === undefined ? {} : { undoMergeIntervalMs }),
  })
  const type = (index: number, insert: string) =>
    engine.textSplice({ handle, text: 'body', runs: [{ index, remove: 0, insert }], judge: 'none' })
  return { engine, handle, type }
}

const bodyOf = async (engine: Engine, handle: number) => {
  const { value } = await engine.read({ handle, query: { query: 'markdownBody' } })
  return (value as { ok: string }).ok
}

/** Undoes until nothing is left, answering the body after each step. */
async function undoAll(engine: Engine, handle: number): Promise<string[]> {
  const bodies: string[] = []
  while (engine.undoState({ handle }).canUndo && bodies.length < 10) {
    engine.undo({ handle, judge: 'none' })
    bodies.push(await bodyOf(engine, handle))
  }
  return bodies
}

describe('the clock behind the engine’s undo merge window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    0, 100, 499,
  ])('undoes two writes %ims apart as one step under fake timers', async (gap) => {
    const { engine, handle, type } = openTyped(500)
    type(0, 'a')
    await vi.advanceTimersByTimeAsync(gap)
    type(1, 'b')

    expect(await undoAll(engine, handle)).toEqual([''])
  })

  it.each([
    500, 501, 600,
  ])('undoes two writes %ims apart as two steps under fake timers', async (gap) => {
    const { engine, handle, type } = openTyped(500)
    type(0, 'a')
    await vi.advanceTimersByTimeAsync(gap)
    type(1, 'b')

    expect(await undoAll(engine, handle)).toEqual(['a', ''])
  })

  it('moves the merge window when the system time is set, with no timer advanced', async () => {
    const near = openTyped(500)
    near.type(0, 'a')
    vi.setSystemTime(Date.now() + 100)
    near.type(1, 'b')
    const far = openTyped(500)
    far.type(0, 'a')
    vi.setSystemTime(Date.now() + 600)
    far.type(1, 'b')

    expect(await undoAll(near.engine, near.handle)).toEqual([''])
    expect(await undoAll(far.engine, far.handle)).toEqual(['a', ''])
  })

  it('follows the interval the document was opened with', async () => {
    const { engine, handle, type } = openTyped(50)
    type(0, 'a')
    await vi.advanceTimersByTimeAsync(100)
    type(1, 'b')

    expect(await undoAll(engine, handle)).toEqual(['a', ''])
  })

  it('reports an undo and a redo after the merged step as one step each', async () => {
    const { engine, handle, type } = openTyped(500)
    type(0, 'a')
    await vi.advanceTimersByTimeAsync(100)
    type(1, 'b')

    engine.undo({ handle, judge: 'none' })
    expect(engine.undoState({ handle })).toEqual({ canUndo: false, canRedo: true })
    engine.redo({ handle, judge: 'none' })

    expect(await bodyOf(engine, handle)).toBe('ab')
    expect(engine.undoState({ handle })).toEqual({ canUndo: true, canRedo: false })
  })
})

describe('the engine’s undo merge window on the wall clock', () => {
  it('merges two writes made back to back', async () => {
    const { engine, handle, type } = openTyped(500)
    type(0, 'a')
    type(1, 'b')

    expect(await undoAll(engine, handle)).toEqual([''])
  })
})
