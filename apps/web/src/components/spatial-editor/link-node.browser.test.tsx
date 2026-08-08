// Link nodes (JSON Canvas `type: 'link'`): created from the palette's URL
// dialog, followed via double press or the context menu, rewritten via
// Edit URL. Real pointer input where the double-press pairing matters —
// synthetic-event-only coverage is how this editor's first-touch bugs
// survived unnoticed.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const empty: SpatialCanvas = { nodes: [], edges: [] }

const withLink: SpatialCanvas = {
  nodes: [
    {
      id: 'l1',
      type: 'link',
      x: 100,
      y: 100,
      width: 200,
      height: 60,
      url: 'https://example.com/docs',
    },
  ],
  edges: [],
}

function makeHost(initial: SpatialCanvas) {
  const latest: { canvas: SpatialCanvas; commands: string[] } = { canvas: initial, commands: [] }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          canvas={canvas}
          onChange={(next, command) => {
            latest.commands.push(command.kind)
            setCanvas(next)
          }}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

// The dialog sits centered in the editor, which the vitest browser iframe's
// visible viewport may not fully contain — Playwright then refuses the
// click as "outside of the viewport". The button itself is static, so a
// direct DOM click is the faithful interaction (same rationale as the
// context-menu option rows).
function clickOk(container: HTMLElement) {
  const ok = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'OK',
  ) as HTMLButtonElement
  fireEvent.click(ok)
}

function rightClick(el: HTMLElement, x: number, y: number) {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + x,
      clientY: r.top + y,
      button: 2,
    }),
  )
}

it('Add link opens the URL dialog and a valid submit creates a link node', async () => {
  const { Host, latest } = makeHost(empty)
  const { container } = render(<Host />)

  await userEvent.click(page.getByRole('button', { name: 'Add link' }))
  await expect.element(page.getByTestId('link-url-dialog')).toBeInTheDocument()

  const input = container.querySelector('[data-testid="link-url-dialog"] input') as HTMLInputElement
  await userEvent.fill(input, 'https://jsoncanvas.org/spec/1.0/')
  clickOk(container)

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(latest.canvas.nodes[0]).toMatchObject({
    type: 'link',
    url: 'https://jsoncanvas.org/spec/1.0/',
  })
  expect(latest.commands).toContain('create-node')
  // The dialog closes and the node renders its URL as the label.
  expect(container.querySelector('[data-testid="link-url-dialog"]')).toBeNull()
  await vi.waitFor(() =>
    expect(container.textContent).toContain('https://jsoncanvas.org/spec/1.0/'),
  )
})

it('an invalid URL cannot be submitted', async () => {
  const { Host, latest } = makeHost(empty)
  const { container } = render(<Host />)

  await userEvent.click(page.getByRole('button', { name: 'Add link' }))
  const input = container.querySelector('[data-testid="link-url-dialog"] input') as HTMLInputElement
  await userEvent.fill(input, 'not a url')

  const ok = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'OK',
  ) as HTMLButtonElement
  expect(ok.disabled).toBe(true)
  fireEvent.submit(ok.closest('form') as HTMLFormElement)
  expect(latest.canvas.nodes).toHaveLength(0)

  // Escape dismisses without creating anything.
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="link-url-dialog"]')).toBeNull(),
  )
  expect(latest.canvas.nodes).toHaveLength(0)
})

it('a real double-click on a link node opens its URL in a new tab', async () => {
  const { Host } = makeHost(withLink)
  const { container } = render(<Host />)
  const opened: string[] = []
  const openSpy = vi.spyOn(window, 'open').mockImplementation((url) => {
    opened.push(String(url))
    return null
  })
  try {
    await userEvent.dblClick(rootOf(container), { position: { x: 200, y: 130 } })
    await vi.waitFor(() => expect(opened).toEqual(['https://example.com/docs']))
    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com/docs',
      '_blank',
      'noopener,noreferrer',
    )
  } finally {
    openSpy.mockRestore()
  }
})

it('the link context menu offers Open link and Edit URL rewrites the target', async () => {
  const { Host, latest } = makeHost(withLink)
  const { container } = render(<Host />)

  rightClick(rootOf(container), 200, 130)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(container.textContent).toContain('Open link')

  await userEvent.click(page.getByRole('menuitem', { name: 'Edit URL' }))
  await expect.element(page.getByTestId('link-url-dialog')).toBeInTheDocument()

  const input = container.querySelector('[data-testid="link-url-dialog"] input') as HTMLInputElement
  // The dialog opens prefilled with the current URL.
  expect(input.value).toBe('https://example.com/docs')
  await userEvent.fill(input, 'https://example.com/changed')
  clickOk(container)

  await vi.waitFor(() =>
    expect(latest.canvas.nodes[0]).toMatchObject({ url: 'https://example.com/changed' }),
  )
  expect(latest.commands).toContain('set-node-url')
})
