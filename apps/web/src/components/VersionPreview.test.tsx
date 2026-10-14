import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FragmentLoaders } from '../lib/fragment-requests.js'
import type { PastDocument } from '../lib/versions-backend.js'
import { VersionPreview } from './VersionPreview.js'

afterEach(cleanup)

// What the preview must draw a past board in, when the workspace's library
// colours its tags: the board and its exports already do.
const LIBRARY: TagLibrary = {
  health: { values: { ok: { color: '4' }, failing: { color: '1' } } },
}

const past: PastDocument = {
  kind: 'spatial',
  canvas: {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 200, height: 100, text: 'api', tags: ['health:ok'] }),
      textNode({
        id: 'b',
        x: 300,
        y: 0,
        width: 200,
        height: 100,
        text: 'db',
        tags: ['health:failing'],
      }),
    ],
    edges: [],
  },
}

const svgOf = (container: HTMLElement): string =>
  container.querySelector('[data-testid="canvas-viewer"] svg')?.outerHTML ?? ''

describe('VersionPreview and the workspace tag library', () => {
  it('draws a past board by intent, with its legend, when given the library', () => {
    const { container } = render(<VersionPreview past={past} tags={{ library: LIBRARY }} />)
    const svg = svgOf(container)
    expect(svg).toContain('data-wb-legend')
    expect(svg).toContain('#059669')
    expect(svg).toContain('#dc2626')
  })

  it('draws the same board uncoloured, with no legend, without one', () => {
    const { container } = render(<VersionPreview past={past} />)
    const svg = svgOf(container)
    expect(svg).toContain('<svg')
    expect(svg).not.toContain('data-wb-legend')
    expect(svg).not.toContain('#059669')
  })
})

describe('VersionPreview typesets what the editor typesets', () => {
  const MATH_AND_FENCE = '$$\nx^2\n$$\n\n```mermaid\ngraph TD; A-->B\n```\n'
  const loaders = (): FragmentLoaders => ({
    math: vi.fn(async (value: string) => ({ svg: `<g data-math="${value}"/>`, height: 40 })),
    diagram: vi.fn(async () => ({ svg: '<g data-diagram="yes"/>', width: 100, height: 80 })),
  })

  it("draws a past note's math block and diagram fence typeset", async () => {
    const l = loaders()
    const { getByTestId } = render(
      <VersionPreview past={{ kind: 'markdown', body: MATH_AND_FENCE }} fragmentLoaders={l} />,
    )
    await vi.waitFor(() => {
      const html = getByTestId('markdown-preview-pane').innerHTML
      expect(html).toContain('data-math="x^2"')
      expect(html).toContain('data-diagram="yes"')
    })
    expect(l.math).toHaveBeenCalledWith('x^2')
  })

  it("draws a past board's math block and diagram fence typeset", async () => {
    const l = loaders()
    const board: PastDocument = {
      kind: 'spatial',
      canvas: {
        nodes: [textNode({ id: 'm', x: 0, y: 0, width: 300, height: 300, text: MATH_AND_FENCE })],
        edges: [],
      },
    }
    const { container } = render(<VersionPreview past={board} fragmentLoaders={l} />)
    await vi.waitFor(() => {
      const svg = svgOf(container)
      expect(svg).toContain('data-math="x^2"')
      expect(svg).toContain('data-diagram="yes"')
    })
    expect(l.math).toHaveBeenCalledWith('x^2')
  })
})

describe('a link drawn in a version', () => {
  const BODY = '[plan](plan) and [site](https://example.com/)'
  const board: PastDocument = {
    kind: 'spatial',
    canvas: {
      nodes: [textNode({ id: 'l', x: 0, y: 0, width: 400, height: 120, text: BODY })],
      edges: [],
    },
  }
  async function click(pastDocument: PastDocument, href: string): Promise<boolean> {
    const { container } = render(<VersionPreview past={pastDocument} />)
    const anchor = await vi.waitFor(() => {
      const found = container.querySelector(`a[href="${href}"]`)
      if (found === null) throw new Error(`no <a href="${href}"> yet`)
      return found
    })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    return event.defaultPrevented
  }

  it.each([
    ['note', { kind: 'markdown', body: BODY } as PastDocument],
    ['board', board],
  ])('a bare-id link in a past %s never navigates the tab', async (_kind, pastDocument) => {
    expect(await click(pastDocument, 'plan')).toBe(true)
  })

  it('a URL with a scheme keeps the browser default', async () => {
    expect(await click({ kind: 'markdown', body: BODY }, 'https://example.com/')).toBe(false)
  })
})
