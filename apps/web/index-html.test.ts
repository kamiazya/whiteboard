import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The boot splash is the only UI that exists before the app bundle (and the
// vendored viewer font main.tsx awaits) has loaded, so it lives in the raw
// HTML with inline CSS. Nothing else can assert on it — index.css and the
// theme class are not applied at that point — hence a file-level contract.
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
// The animated mark itself is the shared external SVG (also embedded by the
// README), self-contained because it renders inside <img> where it can
// inherit nothing from the page.
const svg = readFileSync(new URL('./public/boot-splash.svg', import.meta.url), 'utf8')

describe('index.html boot splash', () => {
  it('paints the boot state INSIDE #root so React removes it on first commit', () => {
    const root = html.slice(html.indexOf('<div id="root">'), html.indexOf('</body>'))
    expect(root).toContain('wb-boot')
  })

  it('references the shared boot-splash SVG asset', () => {
    expect(html).toContain('/boot-splash.svg')
  })

  it('follows the OS color scheme so a dark-mode cold load does not flash white', () => {
    expect(html).toContain('prefers-color-scheme: dark')
  })
})

describe('public/boot-splash.svg', () => {
  it('draws the stroke ONCE (no redraw loop)', () => {
    expect(svg).toMatch(/animation:[^;]*wb-draw/)
    expect(svg).not.toMatch(/animation:[^;]*wb-draw[^;]*infinite/)
  })

  it('settles into an infinite breathing loop after the draw', () => {
    expect(svg).toMatch(/animation:[^;]*wb-breathe[^;]*infinite/)
  })

  it('neutralizes all animation under prefers-reduced-motion', () => {
    const idx = svg.indexOf('prefers-reduced-motion: reduce')
    expect(idx).toBeGreaterThan(-1)
    expect(svg.slice(idx)).toContain('animation: none')
  })

  it('is self-contained (no external references, CSP-safe inside <img>)', () => {
    expect(svg).not.toMatch(/url\(|href=|@import/)
  })
})
