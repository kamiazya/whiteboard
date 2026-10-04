// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { KeeperWorkspaces } from '../lib/workspace-switcher-source.js'
import { useCreateWorkspace } from './use-create-workspace.js'

function keeper(create: ((name: string) => Promise<unknown>) | undefined) {
  const onSwitch = vi.fn()
  const createSpy = create === undefined ? undefined : vi.fn(create)
  const workspaces = {
    source: createSpy === undefined ? {} : { create: createSpy },
    onSwitch,
  } as unknown as KeeperWorkspaces
  return { createSpy, onSwitch, workspaces }
}

const created = { workspaceId: 'ws-1', segment: 'plans' }

describe('useCreateWorkspace', () => {
  it('creates once when submitted twice inside one batch', async () => {
    const { createSpy, workspaces } = keeper(() => new Promise(() => {}))
    const { result } = renderHook(() => useCreateWorkspace(workspaces))

    // One act batch: state is still the pre-render snapshot for both calls.
    act(() => {
      result.current.submit('Plans')
      result.current.submit('Plans')
    })

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(result.current.busy).toBe(true)
  })

  it('sends the trimmed name and does nothing for a blank one', async () => {
    const { createSpy, workspaces } = keeper(() => new Promise(() => {}))
    const { result } = renderHook(() => useCreateWorkspace(workspaces))

    act(() => result.current.submit('   '))
    expect(createSpy).not.toHaveBeenCalled()

    act(() => result.current.submit('  Plans  '))
    expect(createSpy).toHaveBeenCalledWith('Plans')
  })

  it('does nothing for a keeper with no way to create', () => {
    const { workspaces } = keeper(undefined)
    const { result } = renderHook(() => useCreateWorkspace(workspaces))

    act(() => result.current.submit('Plans'))

    expect(result.current.busy).toBe(false)
  })

  it('switches to the handle the keeper answered with, not the typed name', async () => {
    const { onSwitch, workspaces } = keeper(async () => created)
    const { result } = renderHook(() => useCreateWorkspace(workspaces))

    await act(async () => result.current.submit('Plans, the sequel'))

    expect(onSwitch).toHaveBeenCalledExactlyOnceWith('plans')
  })

  it('releases busy after success and tells the caller before it switches', async () => {
    const order: string[] = []
    const { onSwitch, workspaces } = keeper(async () => created)
    onSwitch.mockImplementation(() => order.push('switch'))
    const { result } = renderHook(() =>
      useCreateWorkspace(workspaces, { onCreated: () => order.push('created') }),
    )

    await act(async () => result.current.submit('Plans'))

    expect(order).toEqual(['created', 'switch'])
    expect(result.current.busy).toBe(false)
    await act(async () => result.current.submit('Again'))
    expect(onSwitch).toHaveBeenCalledTimes(2)
  })

  it('reports a refusal, then a retry reaches the keeper and clears it', async () => {
    const attempts: unknown[] = [new Error('keeper said no'), created]
    const { createSpy, onSwitch, workspaces } = keeper(async () => {
      const next = attempts.shift()
      if (next instanceof Error) throw next
      return next
    })
    const { result } = renderHook(() => useCreateWorkspace(workspaces))

    await act(async () => result.current.submit('Plans'))
    expect(result.current.error).toBe('keeper said no')
    expect(result.current.busy).toBe(false)
    expect(onSwitch).not.toHaveBeenCalled()

    await act(async () => result.current.submit('Plans'))
    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
    expect(onSwitch).toHaveBeenCalledTimes(1)
  })

  it('words a session with no person, wherever the keeper raises it', async () => {
    const { workspaces } = keeper(() =>
      Promise.reject({
        status: 403,
        body: { error: 'requires_person_session', message: 'no person on this session' },
      }),
    )
    const { result } = renderHook(() => useCreateWorkspace(workspaces))

    await act(async () => result.current.submit('Plans'))

    expect(result.current.error).toMatch(/not signed in as a person/i)
    expect(result.current.error).toMatch(/nothing was created/i)
  })

  it('clearError drops the shown refusal', async () => {
    const { workspaces } = keeper(() => Promise.reject(new Error('keeper said no')))
    const { result } = renderHook(() => useCreateWorkspace(workspaces))
    await act(async () => result.current.submit('Plans'))

    act(() => result.current.clearError())

    expect(result.current.error).toBeNull()
  })
})
