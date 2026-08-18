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

/**
 * The editor's on-screen state, for a failure that would otherwise only say
 * an element was missing.
 *
 * This file fails intermittently in CI and has never reproduced locally, so
 * the next failure has to explain itself. The discriminator is the mode
 * group: `EditorToolbar` OMITS the Split button entirely when
 * `splitAvailable` is false, so a run where Split is absent measured its
 * container under `SPLIT_MIN_WIDTH` and fell back to Write — which removes
 * the divider AND the preview pane, and is a different bug from the panes
 * being present but unlaid-out.
 */
function editorState(): string {
  const box = (el: Element | null): string => {
    if (el === null) return 'absent'
    const r = el.getBoundingClientRect()
    return `${Math.round(r.width)}x${Math.round(r.height)}`
  }
  const modes = [...document.querySelectorAll('[aria-label="View mode"] button')]
    .map((b) => `${b.getAttribute('aria-label')}:${b.getAttribute('aria-pressed')}`)
    .join(',')
  const scroller = document.querySelector('.cm-scroller')
  return [
    `modes=[${modes}]`,
    `sourceWrap=${box(document.querySelector('[data-testid="markdown-source-wrap"]'))}`,
    `cmScroller=${box(scroller)}`,
    scroller === null ? '' : `cmScroll=${scroller.scrollHeight}/${scroller.clientHeight}`,
    `preview=${box(document.querySelector('[data-testid="markdown-preview-scroll"]'))}`,
    `viewport=${window.innerWidth}x${window.innerHeight}`,
  ]
    .filter((part) => part !== '')
    .join(' ')
}

/** `getByTestId`'s own error names the id and nothing else. */
function requireDivider(getByTestId: (id: string) => HTMLElement): HTMLElement {
  try {
    return getByTestId('markdown-split-divider')
  } catch {
    throw new Error(`split divider missing — ${editorState()}`)
  }
}

/** A scroller that reports 0/0 is unlaid-out, not merely short. */
function requireScrollable(selector: string): HTMLElement {
  const el = document.querySelector(selector) as HTMLElement | null
  if (el === null) throw new Error(`${selector} absent — ${editorState()}`)
  expect(el.scrollHeight, `${selector} is not scrollable — ${editorState()}`).toBeGreaterThan(
    el.clientHeight,
  )
  return el
}

describe('MarkdownEditor split & scroll sync (real browser)', () => {
  it('dragging the divider resizes the source pane', async () => {
    const { getByTestId } = mount()
    const divider = requireDivider(getByTestId)
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
    const divider = requireDivider(getByTestId)
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
    const scroller = await vi.waitFor(() => requireScrollable('.cm-scroller'))
    const preview = await vi.waitFor(() =>
      requireScrollable('[data-testid="markdown-preview-scroll"]'),
    )

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
    const scroller = await vi.waitFor(() => requireScrollable('.cm-scroller'))
    const preview = await vi.waitFor(() =>
      requireScrollable('[data-testid="markdown-preview-scroll"]'),
    )
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
