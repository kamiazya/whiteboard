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
  // The raw file is scanned — comments included — so shell comments must
  // describe viewport units without writing a literal `<digits><unit>`
  // token. Scanning raw beats comment-stripping: a regex comment-stripper
  // is exactly the incomplete-sanitization pattern CodeQL flags, and the
  // ban losing a match to a comment is worse than wording around it.
  const html = readFileSync(shellPath, 'utf8')

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
