// @vitest-environment jsdom
/**
 * The shell keeps working when the switcher's list will not load — and says
 * so, because an empty switcher otherwise reads as a keeper holding nothing.
 */
import { renderHook } from '@testing-library/react'
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
        '/w/design',
      ),
    )
    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('could not list the workspaces'),
        expect.any(Error),
      ),
    )
    expect(result.current.rows).toEqual([])
    expect(result.current.activeName).toBe('design')
  })
})
