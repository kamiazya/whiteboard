import { describe, expect, it } from 'vitest'
import { type Finalizer, FontHandles } from './font-handles.js'
import {
  type CoreGlue,
  CoreHandleLost,
  CoreInputRefused,
  CoreInstanceTrapped,
  CoreUnrecoverable,
  coreFrom,
  EXPECTED_ABI,
} from './index.js'
import { LayoutCaches } from './layout-caches.js'
import { MAX_RESET_ATTEMPTS, recoverable } from './recover.js'
import { searchOver } from './search.js'

const trap = () => Object.assign(new Error('unreachable'), { name: 'RuntimeError' })
const overflow = () =>
  Object.assign(new Error('Maximum call stack size exceeded'), { name: 'RangeError' })

/** What the fake instance keeps and what a test steers it by. */
function newState() {
  return {
    resets: 0,
    resetFails: 0,
    abi: EXPECTED_ABI,
    nextThrow: undefined as Error | undefined,
    searchCalls: [] as unknown[][],
    released: [] as [string, number][],
    registered: 0,
    nextHandle: 0,
  }
}

/**
 * A glue whose instance is a counter of resets, whose next call to a named
 * export throws what it is told to, and whose handles restart from 0 in each
 * instance as the core's do.
 */
function fakeGlue() {
  const state = newState()
  const maybeThrow = () => {
    const err = state.nextThrow
    state.nextThrow = undefined
    if (err !== undefined) throw err
  }
  const answer = (op: string) => {
    if (op === 'index-new') return `["ok",${state.nextHandle++}]`
    if (op === 'fold') return '["ok","folded"]'
    if (op === 'index-size') return '["ok",0,0]'
    return '["ok",true]'
  }
  const glue = {
    initSync: () => ({}),
    abi_version: () => state.abi,
    __wbg_reset_state() {
      state.resets += 1
      if (state.resetFails > 0) {
        state.resetFails -= 1
        throw new Error('reset failed')
      }
      state.nextHandle = 0
    },
    search_op(request: string) {
      const [op, ...args] = JSON.parse(request) as [string, ...unknown[]]
      state.searchCalls.push([op, ...args])
      maybeThrow()
      return answer(op)
    },
    register_layout_fonts() {
      maybeThrow()
      state.registered += 1
      return `["ok",${state.nextHandle++}]`
    },
    release_layout_fonts(handle: number) {
      state.released.push(['fonts', handle])
      return true
    },
    release_layout_cache(surface: number) {
      state.released.push(['cache', surface])
      return true
    },
  }
  return { glue: glue as unknown as CoreGlue, state }
}

/**
 * A finalizer that collects only when told to, as `FinalizationRegistry` would:
 * an entry is released by the registry that holds it, whichever generation made it.
 */
function finalizerOf() {
  const watched: { token: object; handle: number; registry: number }[] = []
  const releases: ((handle: number) => void)[] = []
  const make = (onCollect: (handle: number) => void): Finalizer => {
    const registry = releases.push(onCollect) - 1
    return {
      register: (_target, handle, token) => void watched.push({ token, handle, registry }),
      unregister: () => undefined,
    }
  }
  const collectAll = (token: object) => {
    for (const entry of watched) if (entry.token === token) releases[entry.registry]?.(entry.handle)
  }
  return { make, collectAll }
}

const errors = {
  refused: (operation: string, code: 'input-too-large' | 'malformed', detail?: string) =>
    new CoreInputRefused(operation, code, detail),
}

describe('a core whose instance trapped', () => {
  it('refuses the call that trapped, once, and answers the next from a fresh instance', () => {
    const { glue, state } = fakeGlue()
    const core = coreFrom(glue, new Uint8Array())
    state.nextThrow = trap()
    expect(() => core.search.foldForSearch('a')).toThrowError(
      expect.objectContaining({ name: 'CoreInstanceTrapped', operation: 'search_op' }),
    )
    expect(state.resets).toBe(1)
    expect(state.searchCalls, 'never retried').toHaveLength(1)
    expect(core.search.foldForSearch('a')).toBe('folded')
    expect(state.resets, 'a healthy call resets nothing').toBe(1)
  })

  it('treats a stack overflow as a trap and a RangeError of the glue own as none', () => {
    const { glue, state } = fakeGlue()
    const core = coreFrom(glue, new Uint8Array())
    state.nextThrow = overflow()
    expect(() => core.search.foldForSearch('a')).toThrow(CoreInstanceTrapped)
    expect(state.resets).toBe(1)

    state.nextThrow = Object.assign(new RangeError('Invalid string length'))
    expect(() => core.search.foldForSearch('a')).toThrow(CoreInputRefused)
    expect(state.resets, 'the instance was never entered').toBe(1)
  })

  it('keeps one Core object, so every root that holds it recovers with it', () => {
    const { glue, state } = fakeGlue()
    const core = coreFrom(glue, new Uint8Array())
    const search = core.search
    state.nextThrow = trap()
    expect(() => search.foldForSearch('a')).toThrow(CoreInstanceTrapped)
    expect(core.search).toBe(search)
    expect(search.foldForSearch('a')).toBe('folded')
  })

  it('shares one generation across the cores built over one glue', () => {
    const { glue, state } = fakeGlue()
    const first = coreFrom(glue, new Uint8Array())
    const second = coreFrom(glue, new Uint8Array())
    const index = first.search.createIndex()
    state.nextThrow = trap()
    expect(() => second.search.foldForSearch('a')).toThrow(CoreInstanceTrapped)
    expect(() => index.size()).toThrow(CoreHandleLost)
    expect(state.resets).toBe(1)
  })

  it('logs one record naming the export and none of what it was sent', () => {
    const { glue, state } = fakeGlue()
    const records: unknown[][] = []
    const core = coreFrom(glue, new Uint8Array(), {
      log: { error: (...record) => void records.push(record) },
    })
    state.nextThrow = trap()
    expect(() => core.search.foldForSearch('a secret document')).toThrow(CoreInstanceTrapped)
    expect(records).toEqual([[{ operation: 'search_op', generation: 1 }, expect.any(String)]])
    expect(JSON.stringify(records)).not.toContain('secret')
  })

  it('passes a throw that is not a trap through, with no reset', () => {
    const { glue, state } = fakeGlue()
    const core = coreFrom(glue, new Uint8Array())
    state.nextThrow = new Error('a host measurer threw')
    expect(() => core.search.foldForSearch('a')).toThrowError(
      expect.objectContaining({ code: 'malformed' }),
    )
    expect(state.resets).toBe(0)
  })
})

describe('a reset that does not work', () => {
  it('is tried a bounded number of times, then every call is refused without reaching the glue', () => {
    const { glue, state } = fakeGlue()
    const core = coreFrom(glue, new Uint8Array())
    state.resetFails = 100
    state.nextThrow = trap()
    expect(() => core.search.foldForSearch('a')).toThrow(CoreUnrecoverable)
    expect(state.resets).toBe(MAX_RESET_ATTEMPTS)
    const before = state.searchCalls.length
    expect(() => core.search.foldForSearch('a')).toThrow(CoreUnrecoverable)
    expect(state.searchCalls).toHaveLength(before)
    expect(state.resets).toBe(MAX_RESET_ATTEMPTS)
  })

  it('recovers when a later attempt of the same reset works', () => {
    const { glue, state } = fakeGlue()
    const core = coreFrom(glue, new Uint8Array())
    state.resetFails = MAX_RESET_ATTEMPTS - 1
    state.nextThrow = trap()
    expect(() => core.search.foldForSearch('a')).toThrow(CoreInstanceTrapped)
    expect(core.search.foldForSearch('a')).toBe('folded')
  })

  it('counts a reset instance that reports another ABI as failed', () => {
    const { glue, state } = fakeGlue()
    const core = coreFrom(glue, new Uint8Array())
    state.abi = 'other'
    state.nextThrow = trap()
    expect(() => core.search.foldForSearch('a')).toThrow(CoreUnrecoverable)
  })
})

describe('a handle from before a reset', () => {
  it('throws CoreHandleLost rather than naming whatever the fresh instance gave that number', () => {
    const { glue, state } = fakeGlue()
    const core = coreFrom(glue, new Uint8Array())
    const old = core.search.createIndex()
    state.nextThrow = trap()
    expect(() => core.search.foldForSearch('a')).toThrow(CoreInstanceTrapped)
    const fresh = core.search.createIndex()
    const sent = state.searchCalls.length
    expect(() => old.size()).toThrow(CoreHandleLost)
    expect(() => old.search('q')).toThrow(CoreHandleLost)
    expect(() => old.remove('a')).toThrow(CoreHandleLost)
    expect(state.searchCalls, 'refused before the glue is called').toHaveLength(sent)
    expect(fresh.size()).toEqual({ documents: 0, bytes: 0 })
  })

  it('refuses an upsert whose own callback reset the instance, rather than writing into the index that took its handle number', () => {
    const { glue, state } = fakeGlue()
    const core = coreFrom(glue, new Uint8Array())
    const old = core.search.createIndex()
    const alsoIndex = () => {
      state.nextThrow = trap()
      expect(() => core.search.foldForSearch('a')).toThrow(CoreInstanceTrapped)
      core.search.createIndex()
      return ''
    }

    const doc = { documentId: 'a', path: 'p', name: 'n', texts: ['t'] }
    expect(() => old.upsert(doc, alsoIndex)).toThrow(CoreHandleLost)
    expect(state.searchCalls.filter((call) => call[0] === 'index-upsert')).toEqual([])
  })

  it('is never released into the fresh instance, by release() or by collection', () => {
    const { glue, state } = fakeGlue()
    const memo = finalizerOf()
    const guarded = recoverable(glue, EXPECTED_ABI)
    const search = searchOver(guarded, errors, memo.make)
    const old = search.createIndex()
    state.nextThrow = trap()
    expect(() => search.foldForSearch('a')).toThrow(CoreInstanceTrapped)
    const fresh = search.createIndex()
    const before = state.searchCalls.length
    old.release()
    memo.collectAll(old)
    expect(state.searchCalls.filter((c) => c[0] === 'index-release')).toEqual([])
    expect(state.searchCalls).toHaveLength(before)
    fresh.release()
    expect(state.searchCalls.at(-1)).toEqual(['index-release', 0])
  })

  it('registers fonts again, and releases the old registration into nothing', () => {
    const { glue, state } = fakeGlue()
    const memo = finalizerOf()
    const guarded = recoverable(glue, EXPECTED_ABI)
    const fonts = new FontHandles(guarded, errors, memo.make)
    const faces = { kind: 'fonts', faces: [] } as const
    expect(fonts.handleOf(faces)).toEqual({ handle: 0 })
    expect(fonts.handleOf(faces)).toEqual({ handle: 0 })
    expect(state.registered).toBe(1)

    state.nextThrow = trap()
    expect(() => guarded.search_op('["fold","a"]')).toThrow(CoreInstanceTrapped)
    expect(fonts.handleOf(faces), 'registered afresh in the new instance').toEqual({ handle: 0 })
    expect(state.registered).toBe(2)

    memo.collectAll(faces)
    expect(state.released, 'one release, for the one live handle').toEqual([['fonts', 0]])
  })

  it('names a content cache by a new surface after a reset', () => {
    const { glue, state } = fakeGlue()
    const memo = finalizerOf()
    const guarded = recoverable(glue, EXPECTED_ABI)
    const caches = new LayoutCaches(guarded, memo.make)
    const cache = {}
    expect(caches.surfaceOf(cache)).toBe(0)
    state.nextThrow = trap()
    expect(() => guarded.search_op('["fold","a"]')).toThrow(CoreInstanceTrapped)
    expect(caches.surfaceOf(cache)).toBe(1)
    expect(caches.surfaceOf(cache)).toBe(1)
    memo.collectAll(cache)
    expect(state.released).toEqual([['cache', 1]])
  })
})
