// A wiki link drawn in a text node is `<a href="<documentId>">`, and the
// editor's pointer guards leave a press on any `a[href]` alone, so the click
// reaches the anchor itself. Followed by the browser, the bare id resolves
// against the page URL and unloads the editor onto a route naming no
// document. The editor answers that click itself: always cancelled, and
// opened through the host's seam when it has one.
//
// A window-level bubble listener records whether the editor prevented the
// click, and then prevents it, so a regression cannot navigate the runner.
import { referenceWire } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

const NOTE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const canvas: SpatialCanvas = {
  nodes: [
    textNode({
      id: 't',
      x: 40,
      y: 40,
      width: 360,
      height: 160,
      text: `see [[${NOTE}]] now\n\nand [site](https://example.com/x)`,
    }),
  ],
  edges: [],
}
const references = referenceWire(
  new Map([[NOTE, { documentId: NOTE, name: 'TheNote', body: 'x' }]]),
)

afterEach(cleanup)

function mount(onOpenDocument?: (id: string) => void) {
  return render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        theme="light"
        canvas={canvas}
        onChange={() => {}}
        references={references}
        {...(onOpenDocument === undefined ? {} : { onOpenDocument })}
      />
    </div>,
  )
}

async function anchorFor(container: HTMLElement, href: string): Promise<Element> {
  return vi.waitFor(
    () => {
      const anchor = container.querySelector(`svg a[href="${href}"]`)
      if (anchor === null) throw new Error(`no <a href="${href}"> yet`)
      return anchor
    },
    { timeout: 20_000 },
  )
}

/** Clicks the anchor's text for real; answers whether the editor prevented it. */
async function clickedPrevented(anchor: Element): Promise<boolean> {
  const seen: boolean[] = []
  const record = (event: MouseEvent) => {
    seen.push(event.defaultPrevented)
    event.preventDefault()
  }
  window.addEventListener('click', record)
  try {
    await userEvent.click(anchor.querySelector('text') ?? anchor)
  } finally {
    window.removeEventListener('click', record)
  }
  expect(seen).toHaveLength(1)
  return seen[0] === true
}

describe('a link drawn in a text node', () => {
  it('a document link opens through the seam and never navigates', async () => {
    const onOpen = vi.fn()
    const { container } = mount(onOpen)
    expect(await clickedPrevented(await anchorFor(container, NOTE))).toBe(true)
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(NOTE)
  })

  it('a document link is cancelled with no seam to open it', async () => {
    const { container } = mount()
    expect(await clickedPrevented(await anchorFor(container, NOTE))).toBe(true)
  })

  it('a URL with a scheme keeps the browser default', async () => {
    const onOpen = vi.fn()
    const { container } = mount(onOpen)
    expect(await clickedPrevented(await anchorFor(container, 'https://example.com/x'))).toBe(false)
    expect(onOpen).not.toHaveBeenCalled()
  })
})
