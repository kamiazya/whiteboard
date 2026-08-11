import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The boot splash is the only UI that exists before the app bundle (and the
// vendored viewer font main.tsx awaits) has loaded, so it lives in the raw
// HTML with inline CSS. Nothing else can assert on it — index.css and the
// theme class are not applied at that point — hence a file-level contract.
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')

describe('index.html boot splash', () => {
  it('paints the boot state INSIDE #root so React removes it on first commit', () => {
    const root = html.slice(html.indexOf('<div id="root">'), html.indexOf('</body>'))
    expect(root).toContain('wb-boot')
  })

  it('follows the OS color scheme so a dark-mode cold load does not flash white', () => {
    expect(html).toContain('prefers-color-scheme: dark')
  })

  it('neutralizes the boot animation under prefers-reduced-motion', () => {
    const idx = html.indexOf('prefers-reduced-motion: reduce')
    expect(idx).toBeGreaterThan(-1)
    expect(html.slice(idx)).toMatch(/animation:[^;]*0\.01ms/)
  })
})
