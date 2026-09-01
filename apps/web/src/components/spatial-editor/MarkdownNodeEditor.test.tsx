// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownNodeEditor } from './MarkdownNodeEditor.js'

afterEach(cleanup)

const BOX = { x: 40, y: 60, width: 200, height: 80 }

describe('MarkdownNodeEditor exit hint', () => {
  it('shows the exit hint below the editing box while open', () => {
    render(
      <MarkdownNodeEditor box={BOX} initialText="hello" onCommit={vi.fn()} onCancel={vi.fn()} />,
    )
    const hint = screen.getByTestId('editor-exit-hint')
    expect(hint.textContent).toContain('Done')
    expect(hint.style.top).toBe(`${BOX.y + BOX.height + 6}px`)
    expect(hint.style.left).toBe(`${BOX.x}px`)
  })
})
