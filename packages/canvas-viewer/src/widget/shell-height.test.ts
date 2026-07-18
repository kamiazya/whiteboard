import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Inline MCP Apps hosts auto-resize the embedding iframe to the widget
// document's scroll height. If the widget shell sizes itself with any
// viewport-relative unit (100vh grows whenever the iframe grows), each host
// measurement feeds back into the next and the iframe balloons without
// bound. The shell must therefore declare a fixed intrinsic height and
// clip its own overflow so scrollHeight always equals content height.
const shellPath = fileURLToPath(new URL('../../canvas-viewer.widget.html', import.meta.url))

describe('widget shell sizing (host auto-resize safety)', () => {
  // Comments may legitimately mention viewport units when explaining this
  // very rule — only effective markup/CSS is checked. Stripping runs to a
  // fixpoint so nested/overlapping comment fragments cannot survive one pass.
  const stripComments = (input: string): string => {
    let out = input
    for (;;) {
      const next = out.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      if (next === out) return next
      out = next
    }
  }
  const html = stripComments(readFileSync(shellPath, 'utf8'))

  it('never uses viewport-relative units for the root size', () => {
    expect(html).not.toMatch(/\b\d+(?:vh|vw|dvh|svh|lvh)\b/)
  })

  it('gives #root a fixed pixel height', () => {
    const rootTag = html.match(/<div id="root"[^>]*>/)?.[0]
    expect(rootTag).toBeDefined()
    expect(rootTag).toMatch(/height:\s*\d+px/)
  })

  it('clips document overflow so scrollHeight equals content height', () => {
    expect(html).toMatch(/overflow:\s*hidden/)
  })
})
