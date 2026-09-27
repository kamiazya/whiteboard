/**
 * A press on the rail while the preview is on screen moves the PREVIEW, and
 * centres what was pressed rather than landing it at the very top. Measured
 * from the document's own SVG: a comment marker's icon is an earlier SVG in
 * the same column, and an origin taken from it is wrong on any document that
 * carries a conversation.
 */
import { renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { usePaneScrollSync } from './use-pane-scroll-sync.js'

function box(top: number): () => DOMRect {
  return () => ({
    top,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: top,
    toJSON() {},
  })
}

/** A preview column 400px tall, scrolled 50px, whose document starts 90px down its content. */
function previewColumn(): HTMLDivElement {
  const preview = document.createElement('div')
  Object.defineProperty(preview, 'clientHeight', { value: 400 })
  preview.scrollTop = 50
  preview.getBoundingClientRect = box(100)

  // A marker's icon, rendered BEFORE the pane, the way the column really is.
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  marker.getBoundingClientRect = box(110)
  preview.appendChild(marker)

  const pane = document.createElement('div')
  pane.className = 'markdown-preview-pane'
  const documentSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  // Its top on screen: the column's top (100) + its offset in the content
  // (90) - the column's scroll (50).
  documentSvg.getBoundingClientRect = box(140)
  pane.appendChild(documentSvg)
  preview.appendChild(pane)
  document.body.appendChild(preview)
  attached.push(preview)
  return preview
}

const attached: HTMLElement[] = []

afterEach(() => {
  for (const element of attached.splice(0)) element.remove()
})

it('a rail press centres the pressed position in the preview, measured from the document', () => {
  const preview = previewColumn()
  const { result } = renderHook(() =>
    usePaneScrollSync({
      value: 'text',
      sourceWrapRef: { current: null },
      previewScrollRef: { current: preview },
      sourceApiRef: { current: null },
      anchorsRef: { current: [] },
      blocksRef: { current: [] },
    }),
  )

  result.current.seekPreview(300)

  // The document starts 90px into the content; 300px into the document is
  // 390px, and centring it in a 400px column puts the top at 190.
  expect(preview.scrollTop).toBe(190)
})
