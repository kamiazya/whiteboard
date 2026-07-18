import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BROWSER_LOCAL_CAPABILITIES } from '../provider.js'
import type { WhiteboardCommandDeps } from './types.js'
import { useWhiteboardCommands } from './use-whiteboard-commands.js'

function deps(overrides: Partial<WhiteboardCommandDeps> = {}): WhiteboardCommandDeps {
  return {
    getExcalidrawApi: () => null,
    provider: { kind: 'browser-local', capabilities: BROWSER_LOCAL_CAPABILITIES },
    canvas: { canvasId: 'c1', name: 'Canvas 1' },
    ...overrides,
  }
}

describe('useWhiteboardCommands', () => {
  it('returns a referentially stable commands object across rerenders', () => {
    const { result, rerender } = renderHook(
      (d: WhiteboardCommandDeps) => useWhiteboardCommands(d),
      {
        initialProps: deps(),
      },
    )
    const first = result.current

    rerender(deps({ canvas: { canvasId: 'c2', name: 'Canvas 2' } }))
    rerender(
      deps({
        provider: {
          kind: 'local-daemon',
          daemonBaseUrl: 'http://x',
          capabilities: BROWSER_LOCAL_CAPABILITIES,
        },
      }),
    )

    expect(result.current).toBe(first)
  })

  it('a call after a rerender sees the latest canvas identity via the live Excalidraw API', async () => {
    const apiA = {
      getSceneElements: () => [{ id: 'a', type: 'rectangle', x: 0, y: 0 } as never],
      getAppState: () => ({ gridSize: null, viewBackgroundColor: '#fff' }),
      getFiles: () => ({}),
    }
    const apiB = {
      getSceneElements: () => [{ id: 'b', type: 'rectangle', x: 0, y: 0 } as never],
      getAppState: () => ({ gridSize: null, viewBackgroundColor: '#000' }),
      getFiles: () => ({}),
    }
    const { result, rerender } = renderHook(
      (d: WhiteboardCommandDeps) => useWhiteboardCommands(d),
      {
        initialProps: deps({ getExcalidrawApi: () => apiA as never }),
      },
    )

    const firstResult = await result.current.exportJson()
    expect(firstResult.elements.map((e) => (e as { id: string }).id)).toEqual(['a'])

    rerender(deps({ getExcalidrawApi: () => apiB as never }))
    const secondResult = await result.current.exportJson()
    expect(secondResult.elements.map((e) => (e as { id: string }).id)).toEqual(['b'])
  })

  it('a call issued after unmount resolves without a stale-state React warning', async () => {
    const api = {
      getSceneElements: () => [{ id: 'a', type: 'rectangle', x: 0, y: 0 } as never],
      getAppState: () => ({ gridSize: null, viewBackgroundColor: '#fff' }),
      getFiles: () => ({}),
    }
    const { result, unmount } = renderHook((d: WhiteboardCommandDeps) => useWhiteboardCommands(d), {
      initialProps: deps({ getExcalidrawApi: () => api as never }),
    })
    const commands = result.current
    unmount()

    await expect(commands.exportJson()).resolves.toMatchObject({ type: 'excalidraw' })
  })
})
