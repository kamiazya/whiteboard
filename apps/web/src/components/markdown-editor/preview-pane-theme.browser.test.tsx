/**
 * Preview-pane text color per theme (real browser).
 *
 * canvas-render assigns markdown body runs no `fill` of their own, so an
 * SVG `<text>` falls back to the SVG default — black — regardless of the
 * app theme. On the dark ground that is black text on near-black: the
 * preview is there, laid out correctly, and unreadable.
 *
 * The host element supplies the inherited fill, the same seam
 * `editorTextFill` was written for. Asserted against the exact intended
 * value per theme rather than "not black", which would pass for any other
 * wrong color too.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EDITOR_DARK_PALETTE, EDITOR_LIGHT_PALETTE } from '../spatial-editor/editor-appearance.js'
import { MarkdownEditor } from './MarkdownEditor.js'

/** A real browser normalizes an inline `fill: '#RRGGBB'` style to `rgb(r, g, b)`. */
function hexToRgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`
}

afterEach(cleanup)

async function firstPreviewText(): Promise<SVGTextElement> {
  await expect
    .poll(() => document.querySelector('[data-testid="markdown-preview-pane"] text'))
    .not.toBeNull()
  return document.querySelector('[data-testid="markdown-preview-pane"] text') as SVGTextElement
}

describe('PreviewPane text color per theme (real browser)', () => {
  it('paints preview body text with the dark theme fill', async () => {
    render(<MarkdownEditor value="# Heading" onChange={vi.fn()} theme="dark" />)
    const text = await firstPreviewText()
    expect(getComputedStyle(text).fill).toBe(hexToRgb(EDITOR_DARK_PALETTE.textFill))
  })

  it('paints preview body text with the light theme fill', async () => {
    render(<MarkdownEditor value="# Heading" onChange={vi.fn()} theme="light" />)
    const text = await firstPreviewText()
    expect(getComputedStyle(text).fill).toBe(hexToRgb(EDITOR_LIGHT_PALETTE.textFill))
  })

  it('defaults to the light fill when no theme is supplied', async () => {
    render(<MarkdownEditor value="# Heading" onChange={vi.fn()} />)
    const text = await firstPreviewText()
    expect(getComputedStyle(text).fill).toBe(hexToRgb(EDITOR_LIGHT_PALETTE.textFill))
  })
})
