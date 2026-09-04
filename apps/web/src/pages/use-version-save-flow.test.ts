/**
 * The race-guard seam both document pages duplicated: `run` no-ops while
 * saving, captures the scope before the save's own await, and bails on
 * outcome/commit/finally alike once the scope has moved on. Written before
 * the extraction (the use-tool-state.test.ts pattern) so it is red against
 * the pages' own inline logic having no shared hook to call.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useVersionSaveFlow } from './use-version-save-flow.js'

/**
 * React defers a `setState` call's effect on rendered output until after
 * the current synchronous stretch of work — automatic batching means
 * `result.current` still reads the PRE-update value at the exact moment a
 * same-tick statement runs `setOutcome('saved')` and calls `commit()` right
 * after it, in either order. So the only way to pin which one the hook
 * actually calls FIRST is to watch the call to the setter itself, not its
 * rendered effect — this wraps `useState` to record the moment
 * `setOutcome('saved')` is invoked, in the same shared array `commit`
 * pushes into.
 */
const { order } = vi.hoisted(() => ({ order: [] as string[] }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <S>(initial: S | (() => S)) => {
      const [value, setValue] = actual.useState(initial)
      const trackedSetValue = (next: S | ((prev: S) => S)): void => {
        if (next === ('saved' as unknown as S)) order.push('setOutcome(saved)')
        setValue(next)
      }
      return [value, trackedSetValue] as const
    },
  }
})

/** A scope ref the test can mutate directly, the way a page's own ref does. */
function scope(initial: string): { current: string } {
  return { current: initial }
}

describe('useVersionSaveFlow', () => {
  it('applies the saved outcome before the commit thunk runs, and runs it once', async () => {
    order.length = 0
    const scopeRef = scope('doc-a')
    let resolveSave!: (commit: () => void) => void
    const save = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveSave = resolve
        }),
    )
    const { result } = renderHook(() => useVersionSaveFlow(scopeRef, save))

    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run('a bookmark')
    })
    expect(result.current.saving).toBe(true)

    const commit = vi.fn(() => {
      order.push('commit')
    })
    await act(async () => {
      resolveSave(commit)
      await runPromise
    })

    expect(save).toHaveBeenCalledWith('a bookmark')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['setOutcome(saved)', 'commit'])
    expect(result.current.outcome).toBe('saved')
    expect(result.current.saving).toBe(false)
  })

  it('sets outcome failed and does not commit when save rejects', async () => {
    const scopeRef = scope('doc-a')
    const commit = vi.fn()
    const save = vi.fn((): Promise<() => void> => Promise.reject(new Error('boom')))
    const { result } = renderHook(() => useVersionSaveFlow(scopeRef, save))

    await act(async () => {
      await result.current.run('a bookmark').catch(() => undefined)
    })

    expect(commit).not.toHaveBeenCalled()
    expect(result.current.outcome).toBe('failed')
    expect(result.current.saving).toBe(false)
  })

  it('is a no-op re-entry while a save is already in flight', async () => {
    const scopeRef = scope('doc-a')
    let resolveSave!: (commit: () => void) => void
    const save = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveSave = resolve
        }),
    )
    const { result } = renderHook(() => useVersionSaveFlow(scopeRef, save))

    let firstRun!: Promise<void>
    act(() => {
      firstRun = result.current.run('first')
    })
    await act(async () => {
      await result.current.run('second')
    })

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('first')

    await act(async () => {
      resolveSave(vi.fn())
      await firstRun
    })
  })

  it('clears a prior outcome to null at the start of a new run', async () => {
    const scopeRef = scope('doc-a')
    const save = vi.fn((): Promise<() => void> => Promise.reject(new Error('boom')))
    const { result } = renderHook(() => useVersionSaveFlow(scopeRef, save))

    await act(async () => {
      await result.current.run('first').catch(() => undefined)
    })
    expect(result.current.outcome).toBe('failed')

    let resolveSecondSave!: (commit: () => void) => void
    save.mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          resolveSecondSave = resolve
        }),
    )
    act(() => {
      void result.current.run('second')
    })
    expect(result.current.outcome).toBe(null)

    await act(async () => {
      resolveSecondSave(vi.fn())
    })
  })

  it('bails on success when the scope switched during the save: outcome stays null, commit is skipped, saving stays true', async () => {
    const scopeRef = scope('doc-a')
    let resolveSave!: (commit: () => void) => void
    const save = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          resolveSave = resolve
        }),
    )
    const { result } = renderHook(() => useVersionSaveFlow(scopeRef, save))

    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run('a bookmark')
    })

    const commit = vi.fn()
    await act(async () => {
      scopeRef.current = 'doc-b'
      resolveSave(commit)
      await runPromise
    })

    expect(commit).not.toHaveBeenCalled()
    expect(result.current.outcome).toBe(null)
    // Verbatim current finally semantics: a bail skips the clear too.
    expect(result.current.saving).toBe(true)
  })

  it('bails on failure when the scope switched during the save: outcome stays null, saving stays true', async () => {
    const scopeRef = scope('doc-a')
    let rejectSave!: (err: unknown) => void
    const save = vi.fn(
      () =>
        new Promise<() => void>((_resolve, reject) => {
          rejectSave = reject
        }),
    )
    const { result } = renderHook(() => useVersionSaveFlow(scopeRef, save))

    let runPromise!: Promise<void>
    act(() => {
      runPromise = result.current.run('a bookmark')
    })

    await act(async () => {
      scopeRef.current = 'doc-b'
      rejectSave(new Error('boom'))
      await runPromise
    })

    expect(result.current.outcome).toBe(null)
    expect(result.current.saving).toBe(true)
  })

  it('clearOutcome resets outcome to null', async () => {
    const scopeRef = scope('doc-a')
    const save = vi.fn((): Promise<() => void> => Promise.reject(new Error('boom')))
    const { result } = renderHook(() => useVersionSaveFlow(scopeRef, save))

    await act(async () => {
      await result.current.run('first').catch(() => undefined)
    })
    expect(result.current.outcome).toBe('failed')

    act(() => {
      result.current.clearOutcome()
    })
    expect(result.current.outcome).toBe(null)
  })
})
