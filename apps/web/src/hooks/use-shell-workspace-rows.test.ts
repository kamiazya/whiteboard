// @vitest-environment jsdom
/**
 * The shell keeps working when the switcher's list will not load — and says
 * so, because an empty switcher otherwise reads as a keeper holding nothing.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { useShellWorkspaceRows } from './use-shell-workspace-rows.js'

describe('useShellWorkspaceRows', () => {
  it('reports a list that will not load, and keeps naming the handle the address carries', async () => {
    const { result } = renderHook(() =>
      useShellWorkspaceRows(
        {
          source: { list: () => Promise.reject(new Error('registry unreadable')) },
          onSwitch: () => {},
        },
        '/w/design',
      ),
    )
    await expectLoggedFailure('could not list the workspaces')
    expect(result.current.rows).toEqual([])
    expect(result.current.activeName).toBe('design')
  })
})
