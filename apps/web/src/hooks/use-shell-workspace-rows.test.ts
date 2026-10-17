// @vitest-environment jsdom
/**
 * The shell keeps working when the switcher's list will not load — and says
 * so, because an empty switcher otherwise reads as a keeper holding nothing.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { useShellWorkspaceRows } from './use-shell-workspace-rows.js'

describe('useShellWorkspaceRows', () => {
  it('reports a list that will not load, and keeps naming the handle the address carries', async () => {
    vi.stubGlobal('import.meta', { env: { DEV: true } })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    onTestFinished(() => {
      info.mockRestore()
      vi.unstubAllGlobals()
    })
    const { result } = renderHook(() =>
      useShellWorkspaceRows(
        {
          source: { list: () => Promise.reject(new Error('registry unreadable')) },
          onSwitch: () => {},
        },
        '/w/me/design',
      ),
    )
    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('could not list the workspaces'),
        expect.any(Error),
      ),
    )
    expect(result.current.rows).toEqual([])
    expect(result.current.activeName).toBe('me/design')
    await vi.waitFor(() => expect(result.current.listFailed).toBe(true))
  })

  it('lists again on reload, and clears the failure once the list lands', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    let failing = true
    const design = { workspaceId: 'ws-1', displayName: 'Design', segment: 'design' }
    const list = () =>
      failing ? Promise.reject(new Error('keeper busy')) : Promise.resolve([design])
    const workspaces = { source: { list }, onSwitch: () => {} }
    const { result } = renderHook(() => useShellWorkspaceRows(workspaces, '/w/me/design'))
    await vi.waitFor(() => expect(result.current.listFailed).toBe(true))

    failing = false
    act(() => result.current.reload())

    await vi.waitFor(() => expect(result.current.activeName).toBe('Design'))
    expect(result.current.listFailed).toBe(false)
  })
})
