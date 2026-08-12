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

describe('index.html social & browser-chrome meta', () => {
  // Link previews (Slack/X/Discord) render from these; without them a
  // shared URL shows as a bare link.
  it('declares Open Graph and Twitter card tags with an absolute og:image', () => {
    expect(html).toContain('property="og:title"')
    expect(html).toContain('property="og:description"')
    expect(html).toMatch(/property="og:image"\s+content="https:\/\/[^"]+og-image\.png"/)
    expect(html).toContain('name="twitter:card"')
    expect(html).toContain('summary_large_image')
  })

  it('declares a meta description', () => {
    expect(html).toMatch(/name="description"\s+content=".{20,}"/)
  })

  // Mobile browser chrome tint follows the app ground per scheme — not the
  // pre-design-refactor navy.
  it('sets theme-color for both color schemes and drops the navy', () => {
    expect(html).toMatch(/name="theme-color"[^>]*media="\(prefers-color-scheme: light\)"/)
    expect(html).toMatch(/name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"/)
    expect(html).not.toContain('#0f172a')
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

  // At full dashoffset some renderers still paint a seam dot / rounded cap
  // at the dash boundary — stray specks over the opening squiggle on real
  // devices. Dash-revealed elements must be fully hidden until they draw.
  it('hides dash-revealed elements until their draw begins', () => {
    expect(svg).toMatch(/\.node,\s*\.edge,\s*\.tidy-edge\s*\{[^}]*opacity: 0/)
    expect(svg).toMatch(/@keyframes wb-drawn\s*\{[^@]*from[^@]*opacity: 1/)
  })

  // The splash follows the OS splash grammar: a single glyph, no container,
  // no caption. The app name lives in the tab title / the OS's own PWA
  // splash, and <text> would render in an unpredictable system font.
  it('is icon-only: no board frame, no wordmark', () => {
    expect(svg).not.toContain('<text')
    expect(svg).not.toMatch(/<rect[^>]*width="172"/)
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
