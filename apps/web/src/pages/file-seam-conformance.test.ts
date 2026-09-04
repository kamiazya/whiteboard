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

const paneSource = import.meta.glob('../components/document-editor/SpatialEditorPane.tsx', {
  query: '?raw',
  import: 'default',
})

async function readPane(): Promise<string> {
  const loader = paneSource['../components/document-editor/SpatialEditorPane.tsx']
  expect(loader, 'no source loader for SpatialEditorPane').toBeDefined()
  return (await loader?.()) as string
}

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
const SHARED_CANVAS_CHROME = [
  'CanvasDisplaySettings',
  'WorkspaceTopBar',
  // The two-row grid <main> shell: everything header-shaped stacks in the
  // auto row and the editor owns minmax(0,1fr). Both pages carried the same
  // grid template and the same sr-only <h1> landmark by hand; the shell owns
  // them once, so a layout or a11y drift between modes cannot happen quietly.
  'DocumentPageShell',
] as const

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
const HOOK = 'data-testid="spatial-editor-container"'
const SLOT = 'spatial={() => ('

/**
 * The slot callback's [start, end) range, by matching the paren the marker
 * opens. `first occurrence comes after the opener` was the original
 * assertion and it has two holes review named: it never proves the hook is
 * INSIDE the callback, and a second hook added after the callback closes —
 * outside it, so rendered for a markdown document too — keeps it green.
 */
function spatialSlotRange(source: string): [number, number] {
  const open = source.indexOf(SLOT)
  if (open === -1) return [-1, -1]
  let depth = 0
  let i = open + SLOT.length - 1
  for (; i < source.length; i++) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return [open, i]
}

function hookOffsets(source: string): number[] {
  const out: number[] = []
  for (let i = source.indexOf(HOOK); i !== -1; i = source.indexOf(HOOK, i + 1)) out.push(i)
  return out
}

/**
 * The spatial editor pane is assembled ONCE, in `SpatialEditorPane`.
 *
 * The editor takes ~23 props and the two pages used to spell them out
 * independently — 19 shared, 14 byte-identical — which is the arrangement
 * that shipped the file-seam defect: a prop added to one call site and not
 * the other diverges silently, because each page's tests only exercise its
 * own mode. With one component owning the assembly, a new prop is added in
 * one place or it does not compile.
 *
 * So a page may not render `<SpatialEditor` directly, and the pane it
 * renders instead must sit inside the `spatial` slot — outside it, the pane
 * (which carries the `spatial-editor-container` hook) would mount for a
 * markdown document too.
 */
describe('the spatial editor pane is built once', () => {
  it.each(PAGES)('%s renders SpatialEditorPane, never SpatialEditor directly', async (page) => {
    const source = await read(page)
    expect(
      /<SpatialEditor[\s/>]/.test(source),
      'a direct <SpatialEditor> render reintroduces the second copy of its ' +
        'prop assembly — add props through SpatialEditorPane instead.',
    ).toBe(false)

    const [start, end] = spatialSlotRange(source)
    expect(start, `${page} has no spatial slot`).toBeGreaterThan(-1)
    const offsets: number[] = []
    for (
      let i = source.indexOf('<SpatialEditorPane');
      i !== -1;
      i = source.indexOf('<SpatialEditorPane', i + 1)
    ) {
      offsets.push(i)
    }
    expect(offsets.length, `${page} renders no SpatialEditorPane`).toBeGreaterThan(0)
    expect(
      offsets.filter((at) => at < start || at > end),
      'a pane outside the spatial slot mounts for a markdown document too.',
    ).toEqual([])
  })
})

describe('the spatial-editor-container hook means one thing', () => {
  // The pane owns the hook, and the "built once" scan above holds the pane
  // inside each page's spatial slot — together they keep the old guarantee
  // (the hook only ever means "a spatial editor is mounted") with the
  // ownership the extraction moved.
  it('the pane carries it exactly once', async () => {
    expect(hookOffsets(await readPane())).toHaveLength(1)
  })

  it.each(PAGES)('%s does not spell it a second time', async (page) => {
    expect(
      hookOffsets(await read(page)),
      'a page-level hook is one the pane does not position — for a markdown ' +
        'document it would answer the wrong question again.',
    ).toEqual([])
  })
})

/**
 * Chrome that belongs to the DOCUMENT, not to the canvas — ADR-0026
 * decision 5. `CommentsPanel` serves a markdown document exactly as it
 * serves a spatial one (a note has no canvas to hang a per-node toggle on),
 * so it deliberately does NOT join `SHARED_CANVAS_CHROME`: that group's own
 * docblock is about chrome the PAGE positions around the editor, and this
 * one is chrome that answers a question about the document as a whole.
 * Kept as its own group so a reader does not have to infer the distinction
 * from where an entry happens to sit.
 */
const SHARED_DOCUMENT_CHROME = ['CommentsPanel'] as const

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

describe('document page document-level chrome', () => {
  it.each(SHARED_DOCUMENT_CHROME)('both pages render %s', async (chrome) => {
    const missing: string[] = []
    for (const page of PAGES) {
      const source = await read(page)
      if (!renders(source, chrome)) missing.push(page)
    }

    expect(
      missing,
      `${chrome} is document-level chrome (ADR-0026 decision 5): a page that ` +
        'omits it leaves that document kind with no way to reach its ' +
        'conversations at all.',
    ).toEqual([])
  })
})

describe('canvas page file seams', () => {
  it.each(PAGES)('%s hands the shared seams to the pane', async (page) => {
    const source = await read(page)

    // The page builds its seams from the shared hook and hands the OBJECT
    // over; the single spread lives in the pane. Enumerating the four props
    // per page is how they drifted apart in the first place.
    expect(source).toContain('fileSeams={fileSeams}')
    expect(source).toContain('useDocumentFileSeams(')
  })

  it('the pane spreads them, once', async () => {
    const source = await readPane()
    expect(source.split('{...fileSeams}')).toHaveLength(2)
  })

  it.each([
    ...PAGES,
    'pane',
  ])('%s builds its seams from an adapter, not inline loading', async (page) => {
    const source = page === 'pane' ? await readPane() : await read(page)

    // Caching (staleness stamps, the same-instance guard, URL revocation)
    // belongs to the shared hook. A page reaching for these again means the
    // logic is being re-derived per backend — the original defect.
    expect(source).not.toContain('createObjectURL')
    expect(source).not.toContain('revokeObjectURL')
  })
})
