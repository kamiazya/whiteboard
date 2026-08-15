/**
 * Editor/preview split UX: a draggable divider resizes the panes, and
 * scrolling the source proportionally scrolls the preview. Real browser —
 * both behaviors depend on real layout/scroll metrics jsdom cannot fake.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const LONG_DOC = Array.from({ length: 80 }, (_, i) => `paragraph ${i}`).join('\n\n')

function mount(value = '') {
  const utils = render(
    <div style={{ width: 800, height: 300 }}>
      <MarkdownEditor value={value} onChange={() => {}} previewDebounceMs={0} />
    </div>,
  )
  return utils
}

describe('MarkdownEditor split & scroll sync (real browser)', () => {
  it('dragging the divider resizes the source pane', async () => {
    const { getByTestId } = mount()
    const divider = getByTestId('markdown-split-divider')
    const source = getByTestId('markdown-source-pane')
    const before = source.getBoundingClientRect().width

    const r = divider.getBoundingClientRect()
    divider.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: r.left + 2,
        clientY: r.top + 50,
        pointerId: 3,
        button: 0,
      }),
    )
    divider.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: r.left - 150,
        clientY: r.top + 50,
        pointerId: 3,
      }),
    )
    divider.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX: r.left - 150,
        clientY: r.top + 50,
        pointerId: 3,
      }),
    )

    await vi.waitFor(() => {
      const after = source.getBoundingClientRect().width
      expect(after).toBeLessThan(before - 100)
    })
  })

  it('the divider is keyboard-operable (arrow keys move the split)', async () => {
    const { getByTestId } = mount()
    const divider = getByTestId('markdown-split-divider')
    const source = getByTestId('markdown-source-pane')
    const before = source.getBoundingClientRect().width

    divider.focus()
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
    await vi.waitFor(() => {
      expect(source.getBoundingClientRect().width).toBeLessThan(before)
    })
  })

  it('scrolling the source proportionally scrolls the preview', async () => {
    mount(LONG_DOC)
    const scroller = await vi.waitFor(() => {
      const el = document.querySelector('.cm-scroller') as HTMLElement
      expect(el.scrollHeight).toBeGreaterThan(el.clientHeight)
      return el
    })
    const preview = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="markdown-preview-scroll"]') as HTMLElement
      expect(el.scrollHeight).toBeGreaterThan(el.clientHeight)
      return el
    })

    scroller.scrollTop = scroller.scrollHeight
    scroller.dispatchEvent(new Event('scroll'))

    await vi.waitFor(() => {
      expect(preview.scrollTop).toBeGreaterThan(0)
    })
  })

  it('scroll sync is line-accurate on a document with uneven block heights', async () => {
    // A diagram fence is THREE source lines but a 600px block in the
    // preview: the proportional map would put the preview near its top when
    // the source scrolls to the marker heading right after the fence.
    // Anchor-based sync must land the preview at the marker's own block,
    // past the tall diagram.
    const doc = `# Top\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\`\n\n# Marker heading\n\n${Array.from(
      { length: 60 },
      (_, i) => `tail paragraph ${i}`,
    ).join('\n\n')}`
    const loaders = {
      math: async () => undefined,
      diagram: async () => ({ svg: '<rect width="100" height="600"/>', width: 100, height: 600 }),
    }
    render(
      <div style={{ width: 800, height: 300 }}>
        <MarkdownEditor
          value={doc}
          onChange={() => {}}
          previewDebounceMs={0}
          fragmentLoaders={loaders}
        />
      </div>,
    )
    const scroller = await vi.waitFor(() => {
      const el = document.querySelector('.cm-scroller') as HTMLElement
      expect(el.scrollHeight).toBeGreaterThan(el.clientHeight)
      return el
    })
    const preview = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="markdown-preview-scroll"]') as HTMLElement
      expect(el.scrollHeight).toBeGreaterThan(el.clientHeight)
      return el
    })
    // Wait for the diagram fragment to land (the preview grows past 600px).
    const markerText = await vi.waitFor(() => {
      expect(preview.querySelector('svg[overflow="visible"]')).not.toBeNull()
      const el = [...preview.querySelectorAll('text, tspan')].find((t) =>
        t.textContent?.includes('Marker'),
      )
      expect(el).toBeDefined()
      return el as SVGGraphicsElement
    })

    // Scroll the SOURCE so the marker heading is the top visible line.
    const markerLine = doc.split('\n').findIndex((l) => l.includes('Marker')) + 1
    const lineCount = doc.split('\n').length
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * (markerLine / lineCount)
    scroller.dispatchEvent(new Event('scroll'))

    await vi.waitFor(() => {
      // Anchored sync: the marker sits near the preview top. The ratio map
      // fails this by construction — the marker is at line ~7 of ~130
      // (preview scrollTop ≈ 5% of range) but sits BELOW a 600px diagram,
      // so it would still be hundreds of px under the viewport top.
      const markerY = markerText.getBoundingClientRect().top - preview.getBoundingClientRect().top
      expect(Math.abs(markerY)).toBeLessThan(150)
    })
  })
})
