import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { FragmentLoaders } from './use-markdown-fragments.js'
import { useMarkdownFragments } from './use-markdown-fragments.js'

const MATH_BODY = 'before\n\n$$\nx^2\n$$\n\nafter'
const FENCE_BODY = '```mermaid\ngraph TD; A-->B\n```\n'

function loaders(overrides: Partial<FragmentLoaders> = {}): FragmentLoaders {
  return {
    math: vi.fn(async (value: string) => ({ svg: `<g data-math="${value}"/>`, height: 40 })),
    diagram: vi.fn(async (lang: string) =>
      lang === 'mermaid' ? { svg: '<g data-diagram/>', width: 100, height: 80 } : undefined,
    ),
    ...overrides,
  }
}

describe('useMarkdownFragments', () => {
  it('resolves a math block through the async loader and serves it synchronously', async () => {
    const l = loaders()
    const { result } = renderHook(() => useMarkdownFragments({ body: MATH_BODY, loaders: l }))
    // Before the first render lands, the sync seam misses (layout keeps its
    // placeholder fallback).
    expect(result.current.renderMath('x^2', true)).toBeUndefined()
    await waitFor(() =>
      expect(result.current.renderMath('x^2', true)).toEqual({
        svg: '<g data-math="x^2"/>',
        height: 40,
      }),
    )
    expect(l.math).toHaveBeenCalledTimes(1)
  })

  it('resolves a mermaid fence and never renders non-diagram fences', async () => {
    const l = loaders()
    const { result, rerender } = renderHook(
      ({ body }) => useMarkdownFragments({ body, loaders: l }),
      { initialProps: { body: FENCE_BODY } },
    )
    await waitFor(() =>
      expect(result.current.renderDiagram('mermaid', 'graph TD; A-->B')).toBeDefined(),
    )
    rerender({ body: '```ts\nconst x = 1\n```\n' })
    await waitFor(() => expect(l.diagram).toHaveBeenCalledWith('ts', 'const x = 1'))
    const declineCalls = (l.diagram as ReturnType<typeof vi.fn>).mock.calls.length
    // A later effect pass over the same body must not re-offer the declined
    // fence — the decline is cached as terminal.
    rerender({ body: '```ts\nconst x = 1\n```\n' })
    await act(async () => {})
    expect((l.diagram as ReturnType<typeof vi.fn>).mock.calls.length).toBe(declineCalls)
    expect(result.current.renderDiagram('ts', 'const x = 1')).toBeUndefined()
  })

  it('never lets a math block and a same-source math fence share a cache row', async () => {
    const l = loaders()
    const body = '$$\nx^2\n$$\n\n```math\nx^2\n```\n'
    const { result } = renderHook(() => useMarkdownFragments({ body, loaders: l }))
    await waitFor(() => expect(result.current.renderMath('x^2', true)).toBeDefined())
    await act(async () => {})
    // The fence went to the diagram loader (which declined the language);
    // its decline must not shadow — nor be shadowed by — the math result.
    expect(l.diagram).toHaveBeenCalledWith('math', 'x^2')
    expect(result.current.renderDiagram('math', 'x^2')).toBeUndefined()
    expect(result.current.renderMath('x^2', true)).toBeDefined()
  })

  it('caches a failed render as terminal instead of retrying it per keystroke', async () => {
    const math = vi.fn(async () => {
      throw new Error('bad tex')
    })
    const l = loaders({ math: math as unknown as FragmentLoaders['math'] })
    const { result, rerender } = renderHook(
      ({ body }) => useMarkdownFragments({ body, loaders: l }),
      { initialProps: { body: MATH_BODY } },
    )
    await waitFor(() => expect(math).toHaveBeenCalledTimes(1))
    // Re-running the effect with the same body must not re-attempt.
    rerender({ body: MATH_BODY })
    await act(async () => {})
    expect(math).toHaveBeenCalledTimes(1)
    expect(result.current.renderMath('x^2', true)).toBeUndefined()
  })

  it('survives a StrictMode double-mount: completions after the dev remount still land', async () => {
    // StrictMode mounts, runs cleanups, and mounts again — a completion
    // guard that latches "unmounted" on the first cleanup silently drops
    // every render for the component's whole life (dev-only; prod never
    // double-mounts, which is what made this class invisible to tests
    // without this wrapper).
    const l = loaders()
    const { result } = renderHook(() => useMarkdownFragments({ body: MATH_BODY, loaders: l }), {
      wrapper: StrictMode,
    })
    await waitFor(() => expect(result.current.renderMath('x^2', true)).toBeDefined())
  })

  it('offers nothing for an unparseable mid-edit body', async () => {
    const l = loaders()
    renderHook(() => useMarkdownFragments({ body: '$$\nx^2', loaders: l }))
    await act(async () => {})
    // Whatever a broken body parses to, only complete math blocks reach the
    // loader — never a crash.
    expect(l.diagram).not.toHaveBeenCalled()
  })
})
