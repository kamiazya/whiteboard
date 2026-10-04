import { describe, expect, it } from 'vitest'
import { KeyedSerializer } from './keyed-serializer.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

interface Op {
  key: string
  yields: number
  fails: boolean
}

const opArb: fc.Arbitrary<Op> = fc.record({
  // Three keys over up to twenty operations, so most runs queue several
  // operations behind each other on one key and interleave the keys.
  key: fc.constantFrom('a', 'b', 'c'),
  yields: fc.integer({ min: 0, max: 4 }),
  fails: fc.boolean(),
})

const yieldTicks = async (ticks: number): Promise<void> => {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('KeyedSerializer', () => {
  fcTest.prop([fc.array(opArb, { minLength: 1, maxLength: 20 })], withDefaults())(
    'runs one key in submission order without overlap, survives a rejection, and drains its map',
    async (ops) => {
      const serializer = new KeyedSerializer()
      const started: Array<{ key: string; index: number }> = []
      const running = new Map<string, number>()
      let overlapped = false

      const settled = ops.map((op, index) =>
        serializer
          .run(op.key, async () => {
            started.push({ key: op.key, index })
            running.set(op.key, (running.get(op.key) ?? 0) + 1)
            if ((running.get(op.key) ?? 0) > 1) overlapped = true
            await yieldTicks(op.yields)
            running.set(op.key, (running.get(op.key) ?? 0) - 1)
            if (op.fails) throw new Error(`op ${index}`)
            return index
          })
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
      )
      const outcomes = await Promise.all(settled)

      expect(overlapped).toBe(false)
      for (const key of ['a', 'b', 'c']) {
        const submitted = ops.flatMap((op, index) => (op.key === key ? [index] : []))
        expect(started.filter((s) => s.key === key).map((s) => s.index)).toEqual(submitted)
      }
      outcomes.forEach((outcome, index) => {
        const op = ops[index]
        if (op === undefined) throw new Error('outcome without an op')
        expect(outcome.ok).toBe(!op.fails)
      })
      expect(serializer.pendingKeys).toBe(0)
    },
  )

  it('lets another key run while one key is held', async () => {
    const serializer = new KeyedSerializer()
    const gate = deferred()
    const held = serializer.run('held', () => gate.promise)

    await expect(serializer.run('free', async () => 'done')).resolves.toBe('done')

    gate.resolve()
    await held
  })

  it('keeps a key pending while its operation is in flight', async () => {
    const serializer = new KeyedSerializer()
    const gate = deferred()
    const held = serializer.run('k', () => gate.promise)
    expect(serializer.pendingKeys).toBe(1)

    gate.resolve()
    await held

    expect(serializer.pendingKeys).toBe(0)
  })

  it('still waits for the operation queued behind one that just finished', async () => {
    const serializer = new KeyedSerializer()
    const events: string[] = []
    const gateA = deferred()
    const gateB = deferred()

    const a = serializer.run('k', async () => {
      events.push('a:start')
      await gateA.promise
      events.push('a:end')
    })
    const b = serializer.run('k', async () => {
      events.push('b:start')
      await gateB.promise
      events.push('b:end')
    })

    gateA.resolve()
    await a
    // The shipped property submits everything synchronously; only a submitter
    // arriving after an earlier operation has cleaned up depends on that
    // operation leaving the newer tail alone.
    await Promise.resolve()
    const c = serializer.run('k', async () => {
      events.push('c:start')
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['a:start', 'a:end', 'b:start'])

    gateB.resolve()
    await Promise.all([b, c])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start'])
    expect(serializer.pendingKeys).toBe(0)
  })
})
