import { describe, expect, it } from 'vitest'
import { findExternalResourceUrls } from './check-html.js'

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

  it('flags a quoted url() form the same as the unquoted form', () => {
    const html = `<style>.a { background: url("https://evil.example.com/a.png") }
      .b { background: url('https://evil.example.com/b.png') }</style>`

    const found = findExternalResourceUrls(html)
    expect(found).toContain('https://evil.example.com/a.png')
    expect(found).toContain('https://evil.example.com/b.png')
  })

  it('flags an UNQUOTED src/href attribute value', () => {
    const html = `<img src=https://example.com/a.png><a href=http://example.com/b>x</a>`

    const found = findExternalResourceUrls(html)
    expect(found).toContain('https://example.com/a.png')
    expect(found).toContain('http://example.com/b')
  })

  it('does not flag inert http(s) strings such as xmlns or license comment URLs', () => {
    const html = `<!doctype html><html><head></head><body>
      <svg xmlns="http://www.w3.org/2000/svg"></svg>
      <!-- license: https://opensource.org/licenses/MIT -->
    </body></html>`

    expect(findExternalResourceUrls(html)).toEqual([])
  })

  it('ignores URL string constants inside inline script bodies', () => {
    // Excalidraw's minified bundle assigns these as literal
    // `.src = "https://…"` strings for its optional tweet/reddit embed
    // feature — compiled JS text, not a resource-loading position in the
    // document. Script BODIES are stripped before scanning, so no URL
    // allowlist is needed (an allowlist would also have suppressed a
    // genuine external tag for the same URL).
    const html = `<script>t.src="https://platform.twitter.com/widgets.js";u.src="https://embed.reddit.com/widgets.js"</script>`

    expect(findExternalResourceUrls(html)).toEqual([])
  })

  it('terminates a script body at an end tag with whitespace (</script >)', () => {
    // HTML closes the element at `</script >` too; if the stripper missed
    // it, the following genuine external tag would be swallowed into the
    // "body" and hidden from the scan.
    const html = `<script>t.src="https://inert.example.com/in-js.js"</script >
      <img src="https://tracker.example.com/pixel.gif">`

    expect(findExternalResourceUrls(html)).toEqual(['https://tracker.example.com/pixel.gif'])
  })

  it('still flags a genuine external tag even for URLs that also appear as script string constants', () => {
    const html = `<script>t.src="https://platform.twitter.com/widgets.js"</script>
      <script src="https://platform.twitter.com/widgets.js"></script>
      <img src="https://tracker.example.com/pixel.gif">`

    const found = findExternalResourceUrls(html)
    expect(found).toContain('https://platform.twitter.com/widgets.js')
    expect(found).toContain('https://tracker.example.com/pixel.gif')
  })
})
