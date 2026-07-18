import { describe, expect, it } from 'vitest'
import { DEFAULT_INERT_URL_ALLOWLIST, findExternalResourceUrls } from './check-html.js'

describe('findExternalResourceUrls', () => {
  it('returns an empty array for a fully self-contained document', () => {
    const html = `<!doctype html><html><head>
      <style>body { background: url(data:image/png;base64,AAAA) }</style>
    </head><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>
      <script>console.log('inline')</script>
    </body></html>`

    expect(findExternalResourceUrls(html)).toEqual([])
  })

  it('flags an http(s) URL in src=, href=, and url() resource-loading positions', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css">
      <style>.x { background: url(https://evil.example.com/x.png) }</style>
    </head><body>
      <img src="http://example.com/pic.png">
    </body></html>`

    const found = findExternalResourceUrls(html)
    expect(found).toContain('https://fonts.googleapis.com/css')
    expect(found).toContain('https://evil.example.com/x.png')
    expect(found).toContain('http://example.com/pic.png')
  })

  it('does not flag inert http(s) strings such as xmlns or license comment URLs', () => {
    const html = `<!doctype html><html><head></head><body>
      <svg xmlns="http://www.w3.org/2000/svg"></svg>
      <!-- license: https://opensource.org/licenses/MIT -->
    </body></html>`

    expect(findExternalResourceUrls(html)).toEqual([])
  })

  it('does not flag Excalidraw-embedded social-embed string constants covered by the default allowlist', () => {
    // Excalidraw's minified bundle assigns these as a literal
    // `.src = "https://…"` for its optional tweet/reddit embed feature —
    // a string constant that only becomes a real request if a scene
    // contains that embed type, never at rest.
    const html = `<script>t.src="https://platform.twitter.com/widgets.js";u.src="https://embed.reddit.com/widgets.js"</script>`

    expect(findExternalResourceUrls(html)).toEqual([])
  })

  it('still flags an unknown URL even when a default allowlist is in effect', () => {
    const html = `<img src="https://platform.twitter.com/widgets.js"><img src="https://tracker.example.com/pixel.gif">`

    expect(findExternalResourceUrls(html)).toEqual(['https://tracker.example.com/pixel.gif'])
  })

  it('allows the allowlist to be overridden explicitly', () => {
    const html = `<img src="https://example.com/pic.png">`

    expect(findExternalResourceUrls(html, new Set())).toEqual(['https://example.com/pic.png'])
    expect(DEFAULT_INERT_URL_ALLOWLIST.size).toBeGreaterThan(0)
  })
})
