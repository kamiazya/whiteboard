import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
import { PreviewPane } from './PreviewPane.js'

// The real renderer, observed: which tag library each render was handed.
const rendered = vi.hoisted(() => ({ tagLibraries: [] as unknown[] }))
vi.mock('../../lib/render-preview.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/render-preview.js')>()
  return {
    ...real,
    renderMarkdownPreview: (...args: Parameters<typeof real.renderMarkdownPreview>) => {
      rendered.tagLibraries.push(args[1].tagLibrary)
      return real.renderMarkdownPreview(...args)
    },
  }
})

afterEach(() => {
  cleanup()
})

describe('PreviewPane', () => {
  it('renders an SVG whose content is produced by canvas-render, not an HTML markdown renderer', () => {
    const { container } = render(
      <PreviewPane theme="light" value="# Hello" maxWidth={480} measure={fakeMeasure} />,
    )
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg')
    expect(container.textContent).toContain('Hello')
  })

  it('renders an empty document without throwing', () => {
    expect(() =>
      render(<PreviewPane theme="light" value="" maxWidth={480} measure={fakeMeasure} />),
    ).not.toThrow()
  })

  // The render is memoised and the dependency lint is off, so a library left
  // out of the deps would keep an embedded board's old tag colours.
  it('renders again when only the tag library changes', () => {
    const before = { health: { values: { ok: { color: '4' } } } } as never
    const after = { health: { values: { ok: { color: '1' } } } } as never
    const { rerender } = render(
      <PreviewPane
        theme="light"
        value="# Hi"
        maxWidth={480}
        measure={fakeMeasure}
        tagLibrary={before}
      />,
    )
    rerender(
      <PreviewPane
        theme="light"
        value="# Hi"
        maxWidth={480}
        measure={fakeMeasure}
        tagLibrary={after}
      />,
    )
    expect(rendered.tagLibraries.at(-1)).toBe(after)
  })
})
