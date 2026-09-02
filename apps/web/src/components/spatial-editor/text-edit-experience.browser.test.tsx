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
import { nodeEditor, nodeEditorContent, nodeEditorText } from './node-editor-test-utils.js'
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

async function openEditor(container: HTMLElement): Promise<HTMLElement> {
  await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 150 } })
  await vi.waitFor(() => expect(nodeEditorContent(container)).not.toBeNull())
  // The WRAPPER carries the parity styles (background, typography); the
  // CodeMirror surface inside it inherits them.
  return nodeEditor(container) as HTMLElement
}

it('the SCENE hides the committed text; the transparent editor keeps the typography', async () => {
  const { container } = render(<Host />)
  const editor = await openEditor(container)
  const style = getComputedStyle(editor)

  // Transparent by design: the scene suppresses the edited node's body
  // (`suppressedBodyNodeIds`), so nothing shows through to double — and a
  // shaped node keeps its silhouette instead of vanishing under an opaque
  // rectangle for the whole edit.
  expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  const svgs = [...container.querySelectorAll('svg')].map((svg) => svg.textContent ?? '').join(' ')
  expect(svgs).not.toContain('hello world')
  // Matches the rendered body text (Roboto 16px, 16px line pitch, 8px padding).
  expect(style.fontFamily).toContain('Roboto')
  expect(style.fontSize).toBe('16px')
  expect(style.paddingLeft).toBe('8px')
  expect(style.paddingTop).toBe('8px')
})

it('opens with the caret at the end of the existing text', async () => {
  const { container } = render(<Host />)
  await openEditor(container)

  // Behavioral pin (CodeMirror keeps its selection internal): typing
  // immediately APPENDS — a caret left at position 0 would prepend and
  // read as "my text got replaced".
  await userEvent.keyboard('!')
  expect(nodeEditorText(container)).toBe('hello world!')
})

it('stays transparent in dark mode and types in the dark text fill', async () => {
  const { container } = render(<Host theme="dark" />)
  const editor = await openEditor(container)
  const style = getComputedStyle(editor)

  // Same contract in both themes: the scene's own chrome is the visible
  // fill, so the light-mode white can no longer leak in as a background.
  expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(style.color).not.toBe('rgb(0, 0, 0)')
})
