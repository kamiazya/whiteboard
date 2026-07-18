import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSceneExport } from './useSceneExport'

describe('useSceneExport', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sets exportError when onExport resolves with no blob', async () => {
    const onExport = vi.fn().mockResolvedValue(null)
    const { result } = renderHook(() => useSceneExport({ onExport, filenameBase: 'my-canvas' }))
    await act(async () => {
      await result.current.handleExport('png')
    })
    expect(result.current.exportError).toBe('Export as PNG failed: no data to export.')
  })

  it('sets exportError when onExport rejects', async () => {
    const onExport = vi.fn().mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useSceneExport({ onExport, filenameBase: 'my-canvas' }))
    await act(async () => {
      await result.current.handleExport('svg')
    })
    expect(result.current.exportError).toBe('Export as SVG failed.')
  })

  it('is a no-op when onExport is undefined', async () => {
    const { result } = renderHook(() =>
      useSceneExport({ onExport: undefined, filenameBase: 'my-canvas' }),
    )
    await act(async () => {
      await result.current.handleExport('json')
    })
    expect(result.current.exportError).toBeNull()
  })
})
