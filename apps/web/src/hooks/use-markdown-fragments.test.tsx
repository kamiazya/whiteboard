import { type ReferenceSeams, referenceSeams } from '@kamiazya/whiteboard-canvas-render'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { FragmentLoaders, FragmentSeams } from '../lib/fragment-requests.js'
import { layoutMarkdownOutline } from '../lib/render-preview.js'
import { fakeMeasure } from '../test-utils/fake-measure.js'
import { useMarkdownFragments } from './use-markdown-fragments.js'

const LAYOUT = { measure: fakeMeasure, maxWidth: 480 }

/**
 * The hook as the preview uses it: the seams are handed to a layout of
 * `body` on every render, and that layout is what asks for the sources.
 */
function useLaidOutFragments({
  body,
  loaders,
  references,
}: {
  body: string
  loaders: FragmentLoaders
  references?: ReferenceSeams
}): FragmentSeams {
  const { seams } = useMarkdownFragments(loaders)
  layoutMarkdownOutline(body, { ...LAYOUT, ...(references ? { references } : {}), ...seams })
  return seams
}
const TARGET_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

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
    const { result } = renderHook(() => useLaidOutFragments({ body: MATH_BODY, loaders: l }))
    // Before the first render lands, the sync seam misses (layout keeps its
    // placeholder fallback).
    expect(result.current.renderMath('x^2')).toBeUndefined()
    await waitFor(() =>
      expect(result.current.renderMath('x^2')).toEqual({
        svg: '<g data-math="x^2"/>',
        height: 40,
      }),
    )
    expect(l.math).toHaveBeenCalledTimes(1)
  })

  it('resolves a mermaid fence and never renders non-diagram fences', async () => {
    const l = loaders()
    const { result, rerender } = renderHook(
      ({ body }) => useLaidOutFragments({ body, loaders: l }),
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

  it('never offers a fence with no language to the diagram loader', async () => {
    const l = loaders()
    const body = '```\ngraph TD; A-->B\n```\n\n$$\nx^2\n$$\n'
    const { result } = renderHook(() => useLaidOutFragments({ body, loaders: l }))
    // The math block is the witness that the body's asks were collected at all.
    await waitFor(() => expect(result.current.renderMath('x^2')).toBeDefined())
    expect(l.diagram).not.toHaveBeenCalled()
  })

  it('keys a rendered fence by its language, so a same-source fence in another language misses', async () => {
    const l = loaders()
    const body = '```mermaid\ngraph TD; A-->B\n```\n\n```plantuml\ngraph TD; A-->B\n```\n'
    const { result } = renderHook(() => useLaidOutFragments({ body, loaders: l }))
    await waitFor(() =>
      expect(result.current.renderDiagram('mermaid', 'graph TD; A-->B')).toBeDefined(),
    )
    await waitFor(() => expect(l.diagram).toHaveBeenCalledWith('plantuml', 'graph TD; A-->B'))
    await act(async () => {})
    expect(result.current.renderDiagram('plantuml', 'graph TD; A-->B')).toBeUndefined()
  })

  it('never lets a math block and a same-source math fence share a cache row', async () => {
    const l = loaders()
    const body = '$$\nx^2\n$$\n\n```math\nx^2\n```\n'
    const { result } = renderHook(() => useLaidOutFragments({ body, loaders: l }))
    await waitFor(() => expect(result.current.renderMath('x^2')).toBeDefined())
    await act(async () => {})
    // The fence went to the diagram loader (which declined the language);
    // its decline must not shadow — nor be shadowed by — the math result.
    expect(l.diagram).toHaveBeenCalledWith('math', 'x^2')
    expect(result.current.renderDiagram('math', 'x^2')).toBeUndefined()
    expect(result.current.renderMath('x^2')).toBeDefined()
  })

  it('caches a failed render as terminal instead of retrying it per keystroke', async () => {
    const math = vi.fn(async () => {
      throw new Error('bad tex')
    })
    const l = loaders({ math: math as unknown as FragmentLoaders['math'] })
    const { result, rerender } = renderHook(
      ({ body }) => useLaidOutFragments({ body, loaders: l }),
      { initialProps: { body: MATH_BODY } },
    )
    await waitFor(() => expect(math).toHaveBeenCalledTimes(1))
    // Re-running the effect with the same body must not re-attempt.
    rerender({ body: MATH_BODY })
    await act(async () => {})
    expect(math).toHaveBeenCalledTimes(1)
    expect(result.current.renderMath('x^2')).toBeUndefined()
  })

  it('survives a StrictMode double-mount: completions after the dev remount still land', async () => {
    // StrictMode mounts, runs cleanups, and mounts again — a completion
    // guard that latches "unmounted" on the first cleanup silently drops
    // every render for the component's whole life (dev-only; prod never
    // double-mounts, which is what made this class invisible to tests
    // without this wrapper).
    const l = loaders()
    const { result } = renderHook(() => useLaidOutFragments({ body: MATH_BODY, loaders: l }), {
      wrapper: StrictMode,
    })
    await waitFor(() => expect(result.current.renderMath('x^2')).toBeDefined())
  })

  it('renders math in a blockquote and a diagram fence in a list item', async () => {
    const l = loaders()
    const body = '> $$\n> x^2\n> $$\n\n- item\n\n  ```mermaid\n  graph TD; A-->B\n  ```\n'
    const { result } = renderHook(() => useLaidOutFragments({ body, loaders: l }))
    await waitFor(() => expect(result.current.renderMath('x^2')).toBeDefined())
    await waitFor(() =>
      expect(result.current.renderDiagram('mermaid', 'graph TD; A-->B')).toBeDefined(),
    )
    expect(l.math).toHaveBeenCalledWith('x^2')
    expect(l.diagram).toHaveBeenCalledWith('mermaid', 'graph TD; A-->B')
  })

  it("renders an embedded note's math and diagram fence, as the layout asks for them", async () => {
    const l = loaders()
    const references = referenceSeams(
      new Map([
        [TARGET_ID, { name: 'Target', body: '$$\ny^2\n$$\n\n```mermaid\ngraph TD; C-->D\n```\n' }],
      ]),
    )
    const { result } = renderHook(() =>
      useLaidOutFragments({ body: `before\n\n![[${TARGET_ID}]]\n`, references, loaders: l }),
    )
    await waitFor(() => expect(result.current.renderMath('y^2')).toBeDefined())
    await waitFor(() =>
      expect(result.current.renderDiagram('mermaid', 'graph TD; C-->D')).toBeDefined(),
    )
    expect(l.math).toHaveBeenCalledTimes(1)
    expect(l.math).toHaveBeenCalledWith('y^2')
    expect(l.diagram).toHaveBeenCalledTimes(1)
    expect(l.diagram).toHaveBeenCalledWith('mermaid', 'graph TD; C-->D')
  })

  it("asks for an embedded note's math once its reference loads after the first layout", async () => {
    // A surface's reference bundle is rebuilt as each load lands, so the
    // first layout always sees the embed unresolved; the later layout's asks
    // must still reach the loader after earlier asks are already recorded.
    const l = loaders()
    const body = `$$\nx^2\n$$\n\n![[${TARGET_ID}]]\n`
    const { result, rerender } = renderHook(
      ({ references }: { references?: ReferenceSeams }) =>
        useLaidOutFragments({ body, loaders: l, ...(references ? { references } : {}) }),
      { initialProps: {} as { references?: ReferenceSeams } },
    )
    await waitFor(() => expect(result.current.renderMath('x^2')).toBeDefined())
    expect(l.math).not.toHaveBeenCalledWith('y^2')

    rerender({
      references: referenceSeams(new Map([[TARGET_ID, { name: 'T', body: '$$\ny^2\n$$\n' }]])),
    })
    await waitFor(() => expect(result.current.renderMath('y^2')).toBeDefined())
    expect(l.math).toHaveBeenCalledWith('y^2')
    expect(l.math).toHaveBeenCalledTimes(2)
  })

  it('offers nothing for an unparseable mid-edit body', async () => {
    const l = loaders()
    renderHook(() => useLaidOutFragments({ body: '$$\nx^2', loaders: l }))
    await act(async () => {})
    // Whatever a broken body parses to, only complete math blocks reach the
    // loader — never a crash.
    expect(l.diagram).not.toHaveBeenCalled()
  })
})
