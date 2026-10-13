import { describe, expect, it } from 'vitest'
import type { LoadedReference } from './loaded-reference.js'
import { REFERENCE_BUDGET, walkReferences, walkReferencesSync } from './targets.js'

/** A keeper over a fixed set of bodies, counting every read it is asked for. */
function keeper(bodies: Record<string, string>) {
  const reads: string[] = []
  const read = (target: string): LoadedReference | null => {
    reads.push(target)
    const body = bodies[target]
    return body === undefined ? null : { documentId: target, body }
  }
  return { reads, read, readAsync: async (target: string) => read(target) }
}

describe('walkReferences', () => {
  it('loads what loaded documents name, in discovery order', async () => {
    const { reads, readAsync } = keeper({ a: '![[b]]', b: 'see [[c]]', c: 'leaf' })
    const graph = await walkReferences({ bodies: ['![[a]] and [[gone]]'] }, readAsync)
    expect([...graph.keys()]).toEqual(['a', 'gone', 'b', 'c'])
    expect(graph.get('gone')).toBeNull()
    expect(graph.get('c')).toEqual({ documentId: 'c', body: 'leaf' })
    expect(reads).toEqual(['a', 'gone', 'b', 'c'])
  })

  it('reads each target once, through a diamond and a cycle', async () => {
    const { reads, readAsync } = keeper({ a: '[[c]] [[b]]', b: '[[c]] [[a]]', c: '[[a]]' })
    const graph = await walkReferences({ bodies: ['[[a]] [[b]]'] }, readAsync)
    expect([...graph.keys()]).toEqual(['a', 'b', 'c'])
    expect(reads).toEqual(['a', 'b', 'c'])
  })

  it('stops at the depth the layout draws to', async () => {
    const { reads, readAsync } = keeper({ d1: '![[d2]]', d2: '![[d3]]', d3: '![[d4]]' })
    await walkReferences({ bodies: ['![[d1]]'] }, readAsync)
    expect(reads).toEqual(['d1', 'd2', 'd3'])
  })

  it('reads no more than the budget, and never a picture', async () => {
    const links = Array.from({ length: REFERENCE_BUDGET + 40 }, (_, i) => `[[n${i}]]`)
    const { reads, readAsync } = keeper({})
    await walkReferences({ bodies: [`![[asset:pic]] ${links.join(' ')}`] }, readAsync)
    expect(reads).toHaveLength(REFERENCE_BUDGET)
    expect(reads).not.toContain('asset:pic')
  })

  it('starts every read of a step before any of them settles', async () => {
    const started: string[] = []
    const pending: (() => void)[] = []
    const walk = walkReferences({ bodies: ['[[a]] [[b]]'] }, (target) => {
      started.push(target)
      return new Promise((resolve) => pending.push(() => resolve(null)))
    })
    await expect.poll(() => started).toEqual(['a', 'b'])
    for (const settle of pending) settle()
    expect([...(await walk).keys()]).toEqual(['a', 'b'])
  })

  it('rejects on a failed read unless the caller says what one records', async () => {
    const failing = async (target: string): Promise<LoadedReference | null> => {
      if (target === 'bad') throw new Error('store down')
      return { body: '' }
    }
    await expect(walkReferences({ bodies: ['[[ok]] [[bad]]'] }, failing)).rejects.toThrow(
      'store down',
    )
    const failures: string[] = []
    const graph = await walkReferences({ bodies: ['[[ok]] [[bad]]'] }, failing, {
      onFailure: (target) => {
        failures.push(target)
        return null
      },
    })
    expect(failures).toEqual(['bad'])
    expect(graph.get('bad')).toBeNull()
    expect(graph.get('ok')).toEqual({ body: '' })
  })
})

describe('walkReferencesSync', () => {
  it('answers the graph the async walk does', async () => {
    const bodies = { a: '![[b]] [[a]]', b: '[[c]] ![[asset:x]]', c: '![[d]]', d: '[[e]]' }
    const seeds = { bodies: ['![[a]] [[missing]]'] }
    const sync = keeper(bodies)
    const async = keeper(bodies)
    const graph = walkReferencesSync(seeds, sync.read)
    expect(graph).toEqual(await walkReferences(seeds, async.readAsync))
    expect(sync.reads).toEqual(['a', 'missing', 'b', 'c'])
  })

  it('throws on a failed read unless the caller says what one records', () => {
    const failing = (): LoadedReference | null => {
      throw new Error('unreadable')
    }
    expect(() => walkReferencesSync({ bodies: ['[[x]]'] }, failing)).toThrow('unreadable')
    const graph = walkReferencesSync({ bodies: ['[[x]]'] }, failing, { onFailure: () => null })
    expect(graph.get('x')).toBeNull()
  })
})
