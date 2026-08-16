/**
 * The three rules this hook exists to hold, each stated against the failure
 * it prevents rather than against the implementation. They were written
 * twice by hand before this hook existed, which is why they get a direct
 * test rather than only the coverage its two consumers give them.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { useCallback } from 'react'
import { describe, expect, it } from 'vitest'
import { type PrefetchRequest, usePrefetchedCache } from './use-prefetched-cache.js'

/** A loader whose completion the test controls, one gate per key. */
function gatedLoader() {
  const calls: string[] = []
  const gates = new Map<string, (value: string | undefined) => void>()
  const load = (key: string) => () => {
    calls.push(key)
    return new Promise<string | undefined>((resolve) => {
      gates.set(key, resolve)
    })
  }
  return {
    calls,
    load,
    settle(key: string, value: string | undefined) {
      const resolve = gates.get(key)
      if (resolve === undefined) throw new Error(`no in-flight load for ${key}`)
      gates.delete(key)
      return act(async () => {
        resolve(value)
      })
    },
  }
}

describe('usePrefetchedCache', () => {
  it('answers undefined until the load lands, then the value', async () => {
    const loader = gatedLoader()
    const { result } = renderHook(() =>
      usePrefetchedCache<string>(useCallback(() => [{ key: 'a', load: loader.load('a') }], [])),
    )
    expect(result.current('a')).toBeUndefined()

    await loader.settle('a', 'A')
    await waitFor(() => expect(result.current('a')).toBe('A'))
  })

  it('never re-fetches a key that resolved to nothing', async () => {
    // Absent and "loaded, but there is nothing there" are indistinguishable
    // to the seam and must not be to the loop: caching the failure as
    // absent re-fetches a dangling reference on every single render.
    const loader = gatedLoader()
    const { result, rerender } = renderHook(() =>
      usePrefetchedCache<string>(
        useCallback(() => [{ key: 'gone', load: loader.load('gone') }], []),
      ),
    )
    await loader.settle('gone', undefined)
    await waitFor(() => expect(loader.calls).toEqual(['gone']))

    rerender()
    rerender()
    expect(result.current('gone')).toBeUndefined()
    expect(loader.calls).toEqual(['gone'])
  })

  it('never re-fetches a key whose load rejected', async () => {
    const calls: string[] = []
    const { result, rerender } = renderHook(() =>
      usePrefetchedCache<string>(
        useCallback(
          () => [
            {
              key: 'boom',
              load: () => {
                calls.push('boom')
                return Promise.reject(new Error('nope'))
              },
            },
          ],
          [],
        ),
      ),
    )
    await waitFor(() => expect(calls).toEqual(['boom']))
    await act(async () => {})

    rerender()
    rerender()
    expect(result.current('boom')).toBeUndefined()
    expect(calls).toEqual(['boom'])
  })

  it('starts one load per key across superseded effects, and keeps its result', async () => {
    // Both halves of the stuck-placeholder bug, because they are two sides
    // of one situation. A keystroke re-runs the effect while a load is in
    // flight: `inflight` is what stops the new pass starting a second load
    // for that key, and unmount-scoped (not effect-scoped) completion is
    // what stops the first pass's result being dropped with nothing left to
    // re-fire it. Either one missing loses the content. Modelled by changing
    // `collect`'s identity — exactly what an edited body does — between the
    // load starting and landing.
    const loader = gatedLoader()
    const { result, rerender } = renderHook(
      ({ nonce }: { nonce: number }) =>
        usePrefetchedCache<string>(
          // `nonce` is the point: it re-identifies the callback the way an
          // edited body does, without changing what is collected.
          useCallback(() => [{ key: 'a', load: loader.load('a') }], [nonce]),
        ),
      { initialProps: { nonce: 0 } },
    )
    rerender({ nonce: 1 })
    rerender({ nonce: 2 })

    await loader.settle('a', 'A')
    await waitFor(() => expect(result.current('a')).toBe('A'))
    expect(loader.calls).toEqual(['a'])
  })

  it('follows keys that only become reachable once something has loaded', async () => {
    // The transitive closure: an embedded body referencing further
    // documents. `collect` is handed everything loaded so far, so the next
    // pass can ask for what the last one revealed.
    const loader = gatedLoader()
    const collect = (loaded: readonly string[]): PrefetchRequest<string>[] => {
      const keys = ['a', ...loaded.filter((value) => value.startsWith('->')).map((v) => v.slice(2))]
      return keys.map((key) => ({ key, load: loader.load(key) }))
    }
    const { result } = renderHook(() => usePrefetchedCache<string>(useCallback(collect, [])))

    await loader.settle('a', '->b')
    await waitFor(() => expect(loader.calls).toEqual(['a', 'b']))
    await loader.settle('b', 'B')
    await waitFor(() => expect(result.current('b')).toBe('B'))
  })
})
