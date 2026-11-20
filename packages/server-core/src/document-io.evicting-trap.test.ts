import { describe, expect, it } from 'vitest'
import {
  type CachedTarget,
  DocumentEngineTrapError,
  runEvictingOnEngineTrap,
  runEvictingOnEngineTrapLater,
} from './document-io.js'

/** What loro-crdt's WASM throws when a Rust panic aborts a call. */
const trap = () => Object.assign(new Error('unreachable'), { name: 'RuntimeError' })

function target() {
  const dropped: string[] = []
  const held: CachedTarget = {
    subject: 'the record',
    fields: { workspaceId: 'ws' },
    evict: () => dropped.push('record'),
  }
  return { held, dropped }
}

describe.each([
  {
    name: 'work that answers at once',
    run: (held: CachedTarget, work: () => unknown) =>
      Promise.resolve().then(() => runEvictingOnEngineTrap(held, 'importing an update into', work)),
  },
  {
    name: 'work that answers later',
    run: (held: CachedTarget, work: () => unknown) =>
      runEvictingOnEngineTrapLater(held, 'importing an update into', async () => work()),
  },
])('running work on a cached record: $name', ({ run }) => {
  it('answers what the work answered, dropping nothing', async () => {
    const { held, dropped } = target()
    await expect(run(held, () => 7)).resolves.toBe(7)
    expect(dropped).toEqual([])
  })

  it('drops the record and reports an engine trap as one', async () => {
    const { held, dropped } = target()
    await expect(
      run(held, () => {
        throw trap()
      }),
    ).rejects.toBeInstanceOf(DocumentEngineTrapError)
    expect(dropped).toEqual(['record'])
  })

  it('rethrows any other failure as it came, keeping the record', async () => {
    const { held, dropped } = target()
    const refusal = new Error('refused')
    await expect(
      run(held, () => {
        throw refusal
      }),
    ).rejects.toBe(refusal)
    expect(dropped).toEqual([])
  })
})
