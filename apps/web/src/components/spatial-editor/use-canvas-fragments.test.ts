import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FragmentLoaders } from '../../lib/fragment-requests.js'
import { useCanvasFragments } from './use-canvas-fragments.js'

const FRAGMENT = { svg: '<g data-probe="typeset"/>', width: 40, height: 10 }

function loaders(overrides: Partial<FragmentLoaders> = {}): FragmentLoaders {
  return {
    math: vi.fn(async () => FRAGMENT),
    diagram: vi.fn(async () => FRAGMENT),
    ...overrides,
  }
}

describe('useCanvasFragments', () => {
  it('renders what a layout asked the seams for, then answers it synchronously', async () => {
    const l = loaders()
    const { result } = renderHook(() => useCanvasFragments(l))
    // A layout's first ask misses: the scene keeps its fallback for now.
    act(() => {
      expect(result.current.seams.renderMath('x^2')).toBeUndefined()
    })
    await waitFor(() => expect(result.current.seams.renderMath('x^2')).toEqual(FRAGMENT))
    expect(l.math).toHaveBeenCalledTimes(1)
    expect(l.math).toHaveBeenCalledWith('x^2')
    expect(result.current.entries).toEqual([['math:x^2', FRAGMENT]])
  })

  it("renders what the worker's layout reported asking for, once per source", async () => {
    const l = loaders()
    const { result } = renderHook(() => useCanvasFragments(l))
    const ask = { kind: 'diagram', lang: 'mermaid', value: 'graph TD; A-->B' } as const
    act(() => {
      result.current.onFragmentsAsked([ask])
      result.current.onFragmentsAsked([ask])
    })
    await waitFor(() =>
      expect(result.current.seams.renderDiagram('mermaid', 'graph TD; A-->B')).toEqual(FRAGMENT),
    )
    act(() => result.current.onFragmentsAsked([ask]))
    await act(async () => {})
    expect(l.diagram).toHaveBeenCalledTimes(1)
  })

  it('never re-renders a source whose render failed, however often a layout asks', async () => {
    const math = vi.fn(async () => {
      throw new Error('bad tex')
    })
    const { result } = renderHook(() =>
      useCanvasFragments(loaders({ math: math as unknown as FragmentLoaders['math'] })),
    )
    act(() => {
      result.current.seams.renderMath('\\bad')
    })
    await waitFor(() => expect(math).toHaveBeenCalledTimes(1))
    await act(async () => {})
    act(() => {
      result.current.seams.renderMath('\\bad')
      result.current.onFragmentsAsked([{ kind: 'math', value: '\\bad' }])
    })
    await act(async () => {})
    expect(math).toHaveBeenCalledTimes(1)
    expect(result.current.entries).toEqual([])
  })
})
