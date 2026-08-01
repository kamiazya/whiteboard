import type { FontDescriptor, TextMetrics } from '@kamiazya/whiteboard-canvas-render'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PreviewPane } from './PreviewPane.js'

afterEach(() => {
  cleanup()
})

function fakeMeasure(text: string, font: FontDescriptor): TextMetrics {
  if (text === '') return { advanceWidth: 0, ascent: 0, descent: 0, lineGap: 0 }
  return {
    advanceWidth: text.length * font.sizePx * 0.6,
    ascent: font.sizePx * 0.8,
    descent: font.sizePx * 0.2,
    lineGap: 0,
  }
}

describe('PreviewPane', () => {
  it('renders an SVG whose content is produced by canvas-render, not an HTML markdown renderer', () => {
    const { container } = render(
      <PreviewPane value="# Hello" maxWidth={480} measure={fakeMeasure} />,
    )
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg')
    expect(container.textContent).toContain('Hello')
  })

  it('renders an empty document without throwing', () => {
    expect(() =>
      render(<PreviewPane value="" maxWidth={480} measure={fakeMeasure} />),
    ).not.toThrow()
  })
})
