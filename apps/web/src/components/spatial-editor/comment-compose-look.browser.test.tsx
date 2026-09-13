// The compose bubble is the SAME object as the saved comment's bubble, not a
// plain label editor that a card replaces on commit: the neutral card, the
// amber border, the corner radius, the padding and the floating shadow are
// the theme's comment chrome, read from the same palette the renderer
// paints from. Real browser: computed styles are what a person sees.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello' })],
  edges: [],
  comments: [
    { id: 'c-free', x: 600, y: 450, text: 'free note', createdAt: '2026-09-02T00:00:00.000Z' },
  ],
}

function Host({ theme }: { theme: 'light' | 'dark' }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme={theme} />
    </div>
  )
}

async function composeStyle(): Promise<CSSStyleDeclaration> {
  const compose = page.getByTestId('comment-compose')
  await expect.element(compose).toBeInTheDocument()
  return getComputedStyle(compose.element())
}

it('the create compose bubble wears the light theme comment chrome', async () => {
  const { container } = render(<Host theme="light" />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 400, clientY: r.top + 300, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment here' }))

  const style = await composeStyle()
  expect(style.backgroundColor).toBe('rgb(255, 255, 255)')
  expect(style.borderTopColor).toBe('rgb(217, 119, 6)')
  expect(style.borderTopWidth).toBe('1px')
  expect(style.borderTopLeftRadius).toBe('8px')
  expect(style.paddingLeft).toBe('8px')
  expect(style.boxShadow).not.toBe('none')
})

it('the compose bubble wears the dark theme comment chrome too', async () => {
  // The same claim in the other theme. It used to be driven through the EDIT
  // bubble, which is gone (2026-09-08): editing there could only ever rewrite
  // the opening message, since what it wrote was the flat comment's `text`.
  // The chrome is the compose bubble's either way, so the create gesture
  // makes the claim now.
  const { container } = render(<Host theme="dark" />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 400, clientY: r.top + 300, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment here' }))

  const style = await composeStyle()
  expect(style.backgroundColor).toBe('rgb(38, 38, 38)')
  expect(style.borderTopColor).toBe('rgb(251, 191, 36)')
  expect(style.borderTopLeftRadius).toBe('8px')
  expect(style.boxShadow).not.toBe('none')
})
