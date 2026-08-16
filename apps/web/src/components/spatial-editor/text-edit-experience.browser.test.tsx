// The text editor overlays the node's rendered SVG text. Tailwind's
// preflight makes form controls transparent, so an unstyled textarea let
// the PRE-EDIT text show through under the draft. The editor must be
// opaque and typographically match the rendered text (Roboto 16px, the
// node's own fill and padding), so entering edit mode reads as "the text
// became editable", not "a second box appeared over my text".
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello world' }],
  edges: [],
}

function Host({ theme = 'light' as const }: { theme?: 'light' | 'dark' }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        theme={theme}
      />
    </div>
  )
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

async function openEditor(container: HTMLElement): Promise<HTMLTextAreaElement> {
  await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 150 } })
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  return container.querySelector('textarea') as HTMLTextAreaElement
}

it('covers the rendered text: opaque background matching the node, same typography', async () => {
  const { container } = render(<Host />)
  const editor = await openEditor(container)
  const style = getComputedStyle(editor)

  // Opaque — the pre-edit SVG text must not show through the draft.
  expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  // Matches the rendered body text (Roboto 16px, 16px line pitch, 8px padding).
  expect(style.fontFamily).toContain('Roboto')
  expect(style.fontSize).toBe('16px')
  expect(style.paddingLeft).toBe('8px')
  expect(style.paddingTop).toBe('8px')
})

it('opens with the caret at the end of the existing text', async () => {
  const { container } = render(<Host />)
  const editor = await openEditor(container)

  expect(editor.selectionStart).toBe('hello world'.length)
  expect(editor.selectionEnd).toBe('hello world'.length)
})

it('uses the dark node fill when the theme is dark', async () => {
  const { container } = render(<Host theme="dark" />)
  const editor = await openEditor(container)
  const style = getComputedStyle(editor)

  expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  // The light-mode node fill must not leak into dark mode.
  expect(style.backgroundColor).not.toBe('rgb(255, 255, 255)')
})
