// The compose bubble is the SAME object as the saved comment's bubble, not a
// plain label editor that a card replaces on commit: the neutral card, the
// amber border, the corner radius, the padding and the floating shadow are
// the theme's comment chrome, read from the same palette the renderer
// paints from. Real browser: computed styles are what a person sees.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
  'x-whiteboard': {
    comments: [
      { id: 'c-free', x: 600, y: 450, text: 'free note', createdAt: '2026-09-02T00:00:00.000Z' },
    ],
  },
}

function Host({ theme }: { theme: 'light' | 'dark' }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme={theme} />
    </div>
  )
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
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

it('the edit bubble wears the dark theme comment chrome over the drawn bubble', async () => {
  const { container } = render(<Host theme="dark" />)
  const root = rootOf(container)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
  const r = root.getBoundingClientRect()
  const at = { pointerId: 1, clientX: r.left + 625, clientY: r.top + 470 }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)

  const style = await composeStyle()
  expect(style.backgroundColor).toBe('rgb(38, 38, 38)')
  expect(style.borderTopColor).toBe('rgb(251, 191, 36)')
  expect(style.borderTopLeftRadius).toBe('8px')
  expect(style.boxShadow).not.toBe('none')
})
