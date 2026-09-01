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
const MODE_SPECIFIC_CHROME = {
  // Not a substitute for a save indicator the other mode lacks: BOTH pages
  // render WorkspaceTopBar, whose dot comes from its own `useDirtyState` and
  // means "no manual version named yet" rather than "unsaved". The browser
  // page adds this finer chip because its markdown path has two writers — the
  // controller and the body's debounced save — and one dot reported `Saved`
  // over unwritten text.
  SaveStatusChip: {
    page: './BrowserDocumentPage.tsx',
    why: 'a second, finer indicator its markdown path needs',
  },
  HeaderBranchBanner: {
    page: './DaemonDocumentPage.tsx',
    why: 'branches are a daemon concept (ADR-0004)',
  },
  MergeToast: { page: './DaemonDocumentPage.tsx', why: 'merge is a daemon concept (ADR-0004)' },
  AgentPresenceChip: {
    page: './DaemonDocumentPage.tsx',
    why: 'no agents connect in browser mode',
  },
  ConnectionsChip: {
    page: './DaemonDocumentPage.tsx',
    why: 'backlinks come from the daemon index',
  },
  CapabilityTeaser: { page: './DaemonDocumentPage.tsx', why: 'it teases daemon capabilities' },
} satisfies Record<string, { page: (typeof PAGES)[number]; why: string }>

/**
 * Does this page render that component?
 *
 * A word boundary after the name, because `includes('<Foo')` also matches
 * `<FooPanel` — so a component RENAMED to a longer name reads as still
 * rendered, and every assertion here keeps passing over chrome that is gone.
 * Found by a mutation that renamed `<AgentPresenceChip` to
 * `<AgentPresenceChipX` and did not turn the scan red.
 */
function renders(source: string, chrome: string): boolean {
  return new RegExp(`<${chrome}[\\s/>]`).test(source)
}

/**
 * `spatial-editor-container` must sit INSIDE each page's spatial slot.
 *
 * It is the hook most page tests reach for, and it meant two different things:
 * the daemon page placed it inside the slot, so it answered "a spatial editor
 * is mounted", while the browser page placed it around `DocumentEditorSurface`,
 * so it also appeared for a MARKDOWN document and answered "the editor surface
 * is mounted". Measured — `DocumentEditorSurface` does not render its `spatial`
 * slot for a markdown document, so the two placements cannot agree.
 *
 * One identifier answering two questions makes a test written against one page
 * silently wrong against the other, which is the same defect as chrome one page
 * renders and the other does not, one layer down.
 *
 * A scan rather than a render, for the reason the file-seam scan gives: the
 * property is WHERE the attribute sits in the source, and a render can only see
 * one kind at a time.
 */
describe('the spatial-editor-container hook means one thing', () => {
  it.each(PAGES)('%s places it inside the spatial slot', async (page) => {
    const source = await read(page)
    const slot = source.indexOf('spatial={() => (')
    expect(slot, `${page} has no spatial slot to place it in`).toBeGreaterThan(-1)

    const at = source.indexOf('data-testid="spatial-editor-container"')
    expect(at, `${page} does not expose the hook at all`).toBeGreaterThan(-1)
    expect(
      at,
      'the hook sits before the spatial slot, so it is present for a markdown ' +
        'document too and no longer means "a spatial editor is mounted".',
    ).toBeGreaterThan(slot)
  })
})

describe('document page canvas chrome', () => {
  it.each(SHARED_CANVAS_CHROME)('both pages render %s', async (chrome) => {
    const missing: string[] = []
    for (const page of PAGES) {
      const source = await read(page)
      if (!renders(source, chrome)) missing.push(page)
    }

    expect(
      missing,
      `${chrome} is placed by the PAGE, so a page that omits it drops the ` +
        'surface in that mode entirely. This is the shape that shipped canvas ' +
        'embeds and image nodes doing nothing in daemon mode; a per-page test ' +
        'cannot catch it, because each page only ever exercises its own mode.',
    ).toEqual([])
  })

  // The exemption list is a claim about the code, so it is checked against it —
  // and against the exact page, not merely against "not shared". Naming only
  // the sharing case leaves three ways to be wrong silently: chrome NEITHER
  // page renders any more (a stale entry excusing nothing), chrome whose
  // ownership has flipped, and chrome that quietly became shared. Asserting
  // the owner covers all three with one comparison.
  it.each(
    Object.entries(MODE_SPECIFIC_CHROME),
  )('%s is rendered by its documented page and no other', async (chrome, { page: owner }) => {
    const renderedBy: string[] = []
    for (const page of PAGES) {
      if (renders(await read(page), chrome)) renderedBy.push(page)
    }

    expect(
      renderedBy,
      `${chrome} is exempt as ${owner}-only (${MODE_SPECIFIC_CHROME[chrome as keyof typeof MODE_SPECIFIC_CHROME].why}). ` +
        'Rendered by both means it is shared now — move it to SHARED_CANVAS_CHROME. ' +
        'Rendered by neither means the entry outlived its subject. Rendered by ' +
        'the other page means the exemption is describing the wrong one.',
    ).toEqual([owner])
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
