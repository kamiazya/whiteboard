/**
 * Both canvas pages must hand the editor the same file seams.
 *
 * This exists because they did not: the seams were written inline in
 * BrowserLocalDocumentPage, so DaemonDocumentPage shipped passing none of them and
 * canvas embeds (J5a) and image nodes (J5b) silently did nothing in daemon
 * mode. Nothing failed — each page's own tests only ever exercised its own
 * mode, which is exactly why a per-page test cannot catch this class.
 *
 * A source scan rather than a render: the defect is a missing prop at a call
 * site, and asserting on the call site is what makes "the two pages agree"
 * checkable at all. Tier-2 conformance, same shape as canvas-viewer's
 * geometry conformance test.
 */
import { describe, expect, it } from 'vitest'

const PAGES = ['./BrowserLocalDocumentPage.tsx', './DaemonDocumentPage.tsx'] as const

const sources = import.meta.glob('./{BrowserLocalDocumentPage,DaemonDocumentPage}.tsx', {
  query: '?raw',
  import: 'default',
})

async function read(page: string): Promise<string> {
  const loader = sources[page]
  expect(loader, `no source loader for ${page}`).toBeDefined()
  return (await loader?.()) as string
}

describe('canvas page file seams', () => {
  it.each(PAGES)('%s passes the shared seams to SpatialEditor', async (page) => {
    const source = await read(page)

    // The spread is the point: enumerating the four props per page is how
    // they drifted apart in the first place, so a page that spells them out
    // individually should fail here even if it happens to pass all four.
    expect(source).toContain('{...fileSeams}')
    expect(source).toContain('useDocumentFileSeams(')
  })

  it.each(PAGES)('%s builds its seams from an adapter, not inline loading', async (page) => {
    const source = await read(page)

    // Caching (staleness stamps, the same-instance guard, URL revocation)
    // belongs to the shared hook. A page reaching for these again means the
    // logic is being re-derived per backend — the original defect.
    expect(source).not.toContain('createObjectURL')
    expect(source).not.toContain('revokeObjectURL')
  })
})
