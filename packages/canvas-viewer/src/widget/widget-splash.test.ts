import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The widget is a self-contained single file; until mountCanvasViewer's
// first commit replaces #root's children, whatever sits inside #root is the
// loading state. These pin the mini-splash contract (BRAND.md): the bare
// signature, drawn once then breathing, no container (the widget frame IS
// the container), fully inline (no external resources), reduced-motion
// collapses to the static mark.
const html = readFileSync(new URL('../../canvas-viewer.widget.html', import.meta.url), 'utf8')

describe('widget mini splash', () => {
  it('paints the splash INSIDE #root so the viewer mount replaces it', () => {
    const root = html.slice(html.indexOf('<div id="root"'), html.indexOf('</body>'))
    expect(root).toContain('wb-widget-splash')
  })

  it('draws once and breathes (no redraw loop)', () => {
    expect(html).toMatch(/animation:[^;]*wb-widget-draw/)
    expect(html).not.toMatch(/wb-widget-draw[^;]*infinite/)
    expect(html).toMatch(/wb-widget-breathe[^;]*infinite/)
  })

  it('neutralizes the animation under prefers-reduced-motion', () => {
    const idx = html.indexOf('prefers-reduced-motion: reduce')
    expect(idx).toBeGreaterThan(-1)
    expect(html.slice(idx)).toContain('animation: none')
  })
})
