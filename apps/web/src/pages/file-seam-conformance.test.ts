/**
 * Both document pages must offer the same document-level chrome.
 *
 * This exists because they did not: the seams were written inline in
 * BrowserDocumentPage, so DaemonDocumentPage shipped passing none of them and
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

const PAGES = ['./BrowserDocumentPage.tsx', './DaemonDocumentPage.tsx'] as const

const sources = import.meta.glob('./{BrowserDocumentPage,DaemonDocumentPage}.tsx', {
  query: '?raw',
  import: 'default',
})

async function read(page: string): Promise<string> {
  const loader = sources[page]
  expect(loader, `no source loader for ${page}`).toBeDefined()
  return (await loader?.()) as string
}

/**
 * Canvas-level chrome each page must place, and why a page cannot be trusted
 * to remember it.
 *
 * These are surfaces the PAGE positions rather than the editor — the same
 * arrangement that produced the file-seam defect above. `CanvasDisplaySettings`
 * says so in its own docblock: "Standalone from SpatialEditor so the PAGE
 * places it with the other canvas-level chrome", and it owns the
 * `canvasSettings` contribution point, so a page that does not render it makes
 * every plugin contributing there unreachable in that mode.
 *
 * Measured when this was added: `resolveFacetContributions(bundledFacetRegistry,
 * 'canvasSettings')` answers one group — `visual` contributing
 * `visual.edges/v0` — and only BrowserDocumentPage rendered the gear. A grep
 * for the string `canvasSettings` in plugin-visual finds nothing, because the
 * contribution is declared through the facet definition rather than spelled
 * at a call site; resolving the registry is what shows it is real.
 */
const SHARED_CANVAS_CHROME = ['CanvasDisplaySettings', 'WorkspaceTopBar'] as const

/**
 * Chrome one mode has and the other cannot, per ADR-0004 — capability-gated
 * by design, not drift.
 *
 * Listed rather than left implicit so the scan above stays a statement about
 * what SHOULD agree. Save state is the interesting entry: the daemon page does
 * show it, through `WorkspaceTopBar`'s dirty dot rather than a
 * `SaveStatusChip` in the properties row, so the two presentations differ
 * while the capability does not.
 */
const MODE_SPECIFIC_CHROME: Readonly<Record<string, string>> = {
  // Not a substitute for a save indicator the other mode lacks: BOTH pages
  // render WorkspaceTopBar, whose dot comes from its own `useDirtyState` and
  // means "no manual version named yet" rather than "unsaved". The browser
  // page adds this finer chip because its markdown path has two writers — the
  // controller and the body's debounced save — and one dot reported `Saved`
  // over unwritten text.
  SaveStatusChip: 'browser only; a second, finer indicator its markdown path needs',
  HeaderBranchBanner: 'daemon only; branches are a daemon concept (ADR-0004)',
  MergeToast: 'daemon only; merge is a daemon concept (ADR-0004)',
  AgentPresenceChip: 'daemon only; no agents connect in browser mode',
  ConnectionsChip: 'daemon only; backlinks come from the daemon index',
  CapabilityTeaser: 'daemon only; it teases daemon capabilities',
}

describe('document page canvas chrome', () => {
  it.each(SHARED_CANVAS_CHROME)('both pages render %s', async (chrome) => {
    const missing: string[] = []
    for (const page of PAGES) {
      const source = await read(page)
      if (!source.includes(`<${chrome}`)) missing.push(page)
    }

    expect(
      missing,
      `${chrome} is placed by the PAGE, so a page that omits it drops the ` +
        'surface in that mode entirely. This is the shape that shipped canvas ' +
        'embeds and image nodes doing nothing in daemon mode; a per-page test ' +
        'cannot catch it, because each page only ever exercises its own mode.',
    ).toEqual([])
  })

  // The exemption list is a claim about the code, so it is checked against it.
  // An entry naming chrome that both pages render is stale — it would quietly
  // excuse a real divergence if one appeared there later.
  it('every mode-specific exemption is still one-sided', async () => {
    const both: string[] = []
    for (const [chrome] of Object.entries(MODE_SPECIFIC_CHROME)) {
      const rendered = await Promise.all(
        PAGES.map(async (page) => (await read(page)).includes(`<${chrome}`)),
      )
      if (rendered.every(Boolean)) both.push(chrome)
    }

    expect(
      both,
      'these are rendered by both pages now — move them to SHARED_CANVAS_CHROME ' +
        'so the scan holds them there.',
    ).toEqual([])
  })

  // Neither assertion above means anything if the sources did not load.
  it('reads both page sources', async () => {
    for (const page of PAGES) {
      expect((await read(page)).length, `${page} is empty`).toBeGreaterThan(10_000)
    }
  })
})

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
