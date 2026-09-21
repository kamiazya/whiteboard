import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it } from 'vitest'

// `getOrLoad` is driven directly here rather than through `getDoc`: the
// invariant is about two loads racing, and a test that goes through
// document-store has to stand up a database to reach it. Nothing is mocked,
// so every import is static.
import { clearCache, evictDoc, evictWorkspaceDocs, getOrLoad, peekDoc } from './doc-cache.js'

afterEach(() => {
  clearCache()
})

/** A loader the test releases by hand, counting how often it was entered. */
function deferredLoader() {
  let release!: (doc: LoroDoc) => void
  const entered: number[] = []
  const gate = new Promise<LoroDoc>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    load: () => {
      entered.push(entered.length)
      return gate
    },
  }
}

describe('getOrLoad is single-flight per key', () => {
  it('runs the loader ONCE for two concurrent misses and hands both the same doc', async () => {
    // The defect this prevents: two misses each mint their own LoroDoc, one
    // writer keeps using the instance the other's overwrote out of the cache,
    // and their next saves clobber each other. The cache's own test awaits
    // sequentially, which the LRU alone already satisfies.
    const loader = deferredLoader()
    const first = getOrLoad('ws1', 'doc-a', loader.load)
    const second = getOrLoad('ws1', 'doc-a', loader.load)

    const doc = new LoroDoc()
    loader.release(doc)

    expect(await first).toBe(doc)
    expect(await second).toBe(doc)
    // The count is the discriminator, not the identity: this loader hands
    // every call the same gate, so two flights would still resolve to one
    // doc — and in production they would not. Read after both settle,
    // because `getOrLoad` defers the call by a microtask.
    expect(loader.entered.length).toBe(1)
    expect(peekDoc('ws1', 'doc-a')).toBe(doc)
  })

  it('keeps separate keys on separate flights', async () => {
    // A single-flight map keyed on the wrong thing would collapse these into
    // one load and hand doc-b's caller doc-a's instance.
    const loaderA = deferredLoader()
    const loaderB = deferredLoader()
    const first = getOrLoad('ws1', 'doc-a', loaderA.load)
    const second = getOrLoad('ws1', 'doc-b', loaderB.load)

    const docA = new LoroDoc()
    const docB = new LoroDoc()
    loaderA.release(docA)
    loaderB.release(docB)

    expect(await first).toBe(docA)
    expect(await second).toBe(docB)
  })

  it('a load released after the key was evicted is returned but NOT cached', async () => {
    // `evictDoc` runs after compact or rename replaces on-disk state, so a
    // load that started before it read the OLD bytes. The caller that asked
    // still gets an answer; caching it would serve those bytes to everyone
    // afterwards.
    const loader = deferredLoader()
    const pending = getOrLoad('ws1', 'doc-a', loader.load)

    evictDoc('ws1', 'doc-a')

    const doc = new LoroDoc()
    loader.release(doc)

    expect(await pending).toBe(doc)
    expect(peekDoc('ws1', 'doc-a')).toBeUndefined()
  })

  it('a workspace-wide eviction aborts an in-flight load of that workspace only', async () => {
    const mine = deferredLoader()
    const other = deferredLoader()
    const aborted = getOrLoad('ws1', 'doc-a', mine.load)
    const survivor = getOrLoad('ws2', 'doc-a', other.load)

    evictWorkspaceDocs('ws1')

    const docMine = new LoroDoc()
    const docOther = new LoroDoc()
    mine.release(docMine)
    other.release(docOther)
    await aborted
    await survivor

    expect(peekDoc('ws1', 'doc-a')).toBeUndefined()
    expect(peekDoc('ws2', 'doc-a')).toBe(docOther)
  })

  it('a key pushed out by the LRU reloads instead of replaying its old flight', async () => {
    // The `finally` that clears the pending entry is only reachable this way.
    // Every explicit eviction (`evictDoc`, `evictWorkspaceDocs`, `clearCache`)
    // deletes the pending entry ITSELF, so a test that evicts by hand leaves
    // the `finally` unexercised — measured: removing it left five such cases
    // green. Capacity eviction is the one path that deletes from `cache`
    // alone, and a leaked pending entry there serves the stale doc for the
    // rest of the process: the LRU miss finds no cache row, finds the old
    // promise, and returns the instance that was evicted.
    const original = new LoroDoc()
    await getOrLoad('ws1', 'doc-a', async () => original)

    // CACHE_MAX_SIZE is 32; 32 further keys push 'doc-a' off the cold end.
    for (let i = 0; i < 32; i += 1) {
      await getOrLoad('ws1', `filler-${i}`, async () => new LoroDoc())
    }
    expect(peekDoc('ws1', 'doc-a')).toBeUndefined()

    const reloaded = new LoroDoc()
    expect(await getOrLoad('ws1', 'doc-a', async () => reloaded)).toBe(reloaded)
    expect(peekDoc('ws1', 'doc-a')).toBe(reloaded)
  })

  it('a miss after an explicit eviction settles starts a NEW flight', async () => {
    const first = deferredLoader()
    const pending = getOrLoad('ws1', 'doc-a', first.load)
    evictDoc('ws1', 'doc-a')
    first.release(new LoroDoc())
    await pending

    const second = deferredLoader()
    const reload = getOrLoad('ws1', 'doc-a', second.load)
    const fresh = new LoroDoc()
    second.release(fresh)

    expect(await reload).toBe(fresh)
    expect(second.entered.length).toBe(1)
    expect(peekDoc('ws1', 'doc-a')).toBe(fresh)
  })
})
