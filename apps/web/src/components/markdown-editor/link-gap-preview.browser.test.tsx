/**
 * Space-separated wiki links in the preview, measured by the page's own
 * measurer before the vendored face has loaded. The SVG draws a run naming
 * Roboto through its emitted `system-ui, sans-serif` tail, so a measurer
 * that fell back elsewhere placed each link by narrower advances than it was
 * drawn with, and the space after it was painted over: "Note 0Note 1".
 */
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { type ReferenceLoader, useReferenceSeams } from '../../hooks/use-reference-seams.js'
import { PreviewPane } from './PreviewPane.js'

declare module 'vitest' {
  export interface ProvidedContext {
    onCi: boolean
  }
}

afterEach(cleanup)

const COUNT = 12
const idOf = (i: number) => `01BX5ZZKBKACTAV9WEVG${String(i).padStart(6, '0')}`
const resolveAlias = (alias: string) =>
  alias.startsWith('note-') ? idOf(Number(alias.slice('note-'.length))) : null
const resolveTitle = (id: string) => `Note ${Number(id.slice(20))}`
const body = Array.from({ length: COUNT }, (_, i) => `[[note-${i}]]`).join(' ')
const load: ReferenceLoader = async (target, documentId) => ({
  documentId: documentId ?? idOf(Number(target.slice('note-'.length))),
  body: `prose of ${target}`,
})
const measure = createBrowserMeasureText()

function Note() {
  const references = useReferenceSeams({ body, resolveAlias, resolveTitle, load })
  return (
    <PreviewPane
      theme="light"
      value={body}
      maxWidth={520}
      measure={measure}
      references={references}
    />
  )
}

/** Whether Roboto resolves here, in which case measuring and drawing agree anyway. */
function robotoResolves(): boolean {
  for (const face of document.fonts) {
    if (face.family.replace(/^["']|["']$/g, '') === 'Roboto' && face.status === 'loaded')
      return true
  }
  const probe = document.createElement('canvas').getContext('2d')
  if (probe === null) return true
  probe.font = '16px Roboto'
  const bare = probe.measureText('Note 0 and Note 1').width
  probe.font = '16px system-ui, sans-serif'
  return Math.abs(bare - probe.measureText('Note 0 and Note 1').width) < 0.5
}

describe('space-separated wiki links in the preview', () => {
  it('draws a visible gap between each pair before the vendored face loads', async (ctx) => {
    if (robotoResolves()) {
      // CI's browser has no Roboto, so this premise must hold there: a skip on
      // CI would leave the assertion unrun while every summary stayed green.
      if (inject('onCi'))
        throw new Error('Roboto resolves on CI, so this test would assert nothing')
      return ctx.skip('Roboto resolves here, so there is no fallback to disagree on')
    }
    const { container } = render(<Note />)
    await waitFor(() =>
      expect(container.querySelector(`a[href="${idOf(COUNT - 1)}"] text`)).not.toBeNull(),
    )
    const texts = [...container.querySelectorAll<SVGTextElement>('a text')]
    expect(texts.length).toBeGreaterThanOrEqual(COUNT)
    const gaps = texts.slice(1).flatMap((text, i) => {
      const previous = texts[i] as SVGTextElement
      if (text.getAttribute('y') !== previous.getAttribute('y')) return []
      const end = Number(previous.getAttribute('x')) + previous.getComputedTextLength()
      return [Number(text.getAttribute('x')) - end]
    })
    expect(gaps.length).toBeGreaterThan(3)
    // A drawn space at 16px is about 4px; a gap under half of one reads as none.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(2)
  })
})
