// A caller that already holds the fetch its keeper answers on — server mode's
// injected one — hands it to the daemon half, and every workspace request the
// switcher makes goes through it rather than the global.
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { useShellWorkspaces } from './use-shell-workspaces.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const summary = { workspaceId: 'ws-1', displayName: 'Plans', segment: 'plans' }

describe('useShellWorkspaces with a supplied fetch', () => {
  it('sends the daemon list, create and rename through it, never the global', async () => {
    const globalFetch = vi.fn(() => Promise.reject(new TypeError('global fetch used')))
    vi.stubGlobal('fetch', globalFetch)
    const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        init?.method === undefined
          ? jsonResponse({ workspaces: [summary] })
          : jsonResponse(summary, init.method === 'POST' ? 201 : 200),
      ),
    )
    const { result } = renderHook(() =>
      useShellWorkspaces({
        daemonShellTarget: { baseUrl: 'http://keeper.test' },
        navigate: () => {},
        setDaemonRoute: () => {},
        fetchFn,
      }),
    )
    const source = result.current.daemonWorkspaces?.source
    expect(source).toBeDefined()

    await source?.list()
    await source?.create?.('Plans')
    await source?.rename?.('ws-1', { displayName: 'Plans 2' })

    expect(fetchFn.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
      ['http://keeper.test/api/workspaces', 'GET'],
      ['http://keeper.test/api/workspaces', 'POST'],
      ['http://keeper.test/api/workspaces/ws-1', 'PATCH'],
    ])
    expect(globalFetch).not.toHaveBeenCalled()
  })
})
