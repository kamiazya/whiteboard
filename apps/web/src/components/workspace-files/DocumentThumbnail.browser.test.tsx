import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '../../index.css'
import { DocumentThumbnail } from './DocumentThumbnail.js'

afterEach(cleanup)

const TEXT = 'Compost corner Gardenbeds'
const svgOf = (rootStyle: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="60" viewBox="0 0 300 60" style="${rootStyle}"><text x="0" y="30" font-family="Roboto" font-size="16">${TEXT}</text></svg>`

const doc = { documentId: 'c1', path: 'a/b', name: 'Garden', kind: 'spatial' as const }

function advances(text: SVGTextElement): number[] {
  return Array.from(TEXT, (_, index) => text.getStartPositionOfChar(index).x)
}

describe('DocumentThumbnail text at row size', () => {
  it('keeps glyph advances at the full-size layout, so words do not break apart', async () => {
    // The picture is laid out once at full size and shrunk by the viewBox. The
    // default text rendering rounds each advance at the SHRUNK pixel size, so
    // a 16px run drawn at 0.3x spaces its letters in whole device pixels.
    await ensureViewerFontLoaded()
    const reference = document.createElement('div')
    reference.innerHTML = svgOf('text-rendering:geometricPrecision')
    document.body.appendChild(reference)
    const expected = advances(reference.querySelector('text') as SVGTextElement)
    reference.remove()

    const { container } = render(
      <DocumentThumbnail
        document={doc}
        loadRender={async () => ({
          svg: svgOf(''),
          bounds: { x: 0, y: 0, w: 300, h: 60 },
        })}
        className="h-[18px] w-[90px]"
      />,
    )
    let text: SVGTextElement | null = null
    await waitFor(() => {
      text = container.querySelector('svg text')
      expect(text).not.toBeNull()
    })
    const drawn = advances(text as unknown as SVGTextElement)
    const worst = Math.max(...drawn.map((x, index) => Math.abs(x - (expected[index] ?? 0))))
    expect(worst).toBeLessThan(0.75)
  })
})
