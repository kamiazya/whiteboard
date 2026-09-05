// The one moved behavior the design's manual walk listed that no browser
// test covered: the initial-tool-once effect. The other three walk items
// (facet-panel clear, comment-drag settle, cut invalidation) already have
// real-browser coverage; this pins the fourth at the hook seam the
// decomposition created.
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { EditorTool } from '../../lib/editor-tool.js'
import { useToolState } from './use-tool-state.js'

type Props = { initialTool: EditorTool | undefined }

function mount(initialTool: EditorTool | undefined) {
  return renderHook(
    (p: Props) => useToolState({ defaultTool: 'hand', initialTool: p.initialTool }),
    {
      initialProps: { initialTool } satisfies Props,
    },
  )
}

describe('useToolState initial-tool-once', () => {
  it('stays on defaultTool when no initialTool is given', () => {
    const { result } = mount(undefined)
    expect(result.current.tool).toBe('hand')
  })

  it('applies initialTool once, and a later different initialTool does not re-apply', () => {
    const { result, rerender } = mount('select')
    expect(result.current.tool).toBe('select')
    rerender({ initialTool: 'connect' })
    expect(result.current.tool).toBe('select')
  })

  it("a user's explicit choice beats an initialTool that arrives afterwards", () => {
    const { result, rerender } = mount(undefined)
    act(() => {
      result.current.toolChosenByUserRef.current = true
      result.current.setTool('connect')
    })
    rerender({ initialTool: 'select' })
    expect(result.current.tool).toBe('connect')
  })
})
