// @vitest-environment node
/**
 * The document page's chrome is assembled ONCE, and each keeper page only
 * adds what its keeper alone has.
 *
 * This exists because the chrome used to be assembled twice: the seams were
 * written inline in BrowserDocumentPage, so DaemonDocumentPage shipped
 * passing none of them and canvas embeds (J5a) and image nodes (J5b)
 * silently did nothing in daemon mode. Nothing failed — each page's own
 * tests only ever exercised its own mode, which is exactly why a per-page
 * test cannot catch this class. The shared `DocumentPage` closes it
 * structurally: a prop reaches both keepers or it does not compile. What a
 * scan still holds is the OWNERSHIP — that the shared chrome stays in the
 * shared page rather than growing back into a keeper page, and that the
 * chrome one keeper has is rendered by that keeper's page and no other.
 *
 * A source scan rather than a render: the property is WHERE a component is
 * rendered, and a render can only see one keeper at a time. Tier-2
 * conformance, same shape as canvas-viewer's geometry conformance test.
 */
import { describe, expect, it } from 'vitest'

/** The shared page: every keeper renders through it. */
const SHARED_PAGE = './DocumentPage.tsx'
/** The keeper pages: each builds a model and renders the shared page. */
const KEEPER_PAGES = ['./BrowserDocumentPage.tsx', './DaemonDocumentPage.tsx'] as const
const ALL_PAGES = [SHARED_PAGE, ...KEEPER_PAGES] as const

const sources = import.meta.glob('./{DocumentPage,BrowserDocumentPage,DaemonDocumentPage}.tsx', {
  query: '?raw',
  import: 'default',
})

const paneSource = import.meta.glob('../components/document-editor/SpatialEditorPane.tsx', {
  query: '?raw',
  import: 'default',
})

const railChromeSource = import.meta.glob('../components/annotations/CommentsRailChrome.tsx', {
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
 * Canvas-level chrome the shared page must place, and why a keeper page
 * cannot be trusted to remember it.
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
 * `visual.edges/v0` — and only BrowserDocumentPage rendered it (a gear of its
 * own then; the document's ⋯ opens it now, from the shared page). A grep
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
 * Chrome one keeper has and the other cannot, per ADR-0004 — capability-gated
 * by design, not drift. A keeper page hands it to the shared page through a
 * named slot, so the render site is the keeper page's own source.
 *
 * Listed rather than left implicit so the scan above stays a statement about
 * what SHOULD be shared. Save state is deliberately NOT an entry any more:
 * no page draws one in its chrome. Both keepers publish their health to the
 * shell mark (`setShellConnection`), which draws only a condition — a
 * browser write that is stuck or refused, a daemon session that dropped or
 * was rejected — and nothing while the keeper is keeping.
 */
const MODE_SPECIFIC_CHROME = {
  // These two reasons USED to be "branches/merge are a daemon concept
  // (ADR-0004)". They are not any more — the browser keeper keeps its
  // variations on the workspace record and commits merges over them — so what
  // these entries record is a GAP rather than a difference: the chrome exists
  // on one page because that is where it was written, not because the other
  // keeper cannot have it. Moving it is deliberately not this increment's, so
  // the reason says what is true rather than repeating what was.
  HeaderBranchBanner: {
    page: './DaemonDocumentPage.tsx',
    why: 'gap: the browser keeper has branches now and no banner; the chrome has not been moved yet',
  },
  MergeToast: {
    page: './DaemonDocumentPage.tsx',
    why: 'gap: the browser keeper commits merges now and shows no toast; the chrome has not been moved yet',
  },
  AgentPresenceChip: {
    page: './DaemonDocumentPage.tsx',
    why: 'no agents connect in browser mode',
  },
} satisfies Record<string, { page: (typeof KEEPER_PAGES)[number]; why: string }>

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
 * `spatial-editor-container` must sit INSIDE the spatial slot.
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
 * The spatial editor pane is assembled ONCE, in `SpatialEditorPane`, and
 * rendered once, in the shared page's spatial slot.
 *
 * The editor takes ~23 props and the two pages used to spell them out
 * independently — 19 shared, 14 byte-identical — which is the arrangement
 * that shipped the file-seam defect. With one component owning the assembly
 * and one page rendering it, a new prop is added in one place or it does
 * not compile.
 *
 * So no page may render `<SpatialEditor` directly, and the pane must sit
 * inside the `spatial` slot — outside it, the pane (which carries the
 * `spatial-editor-container` hook) would mount for a markdown document too.
 */
describe('the spatial editor pane is built once', () => {
  it.each(ALL_PAGES)('%s never renders SpatialEditor directly', async (page) => {
    expect(
      /<SpatialEditor[\s/>]/.test(await read(page)),
      'a direct <SpatialEditor> render reintroduces the second copy of its ' +
        'prop assembly — add props through SpatialEditorPane instead.',
    ).toBe(false)
  })

  it('the shared page renders SpatialEditorPane inside its spatial slot', async () => {
    const source = await read(SHARED_PAGE)
    const [start, end] = spatialSlotRange(source)
    expect(start, `${SHARED_PAGE} has no spatial slot`).toBeGreaterThan(-1)
    const offsets: number[] = []
    for (
      let i = source.indexOf('<SpatialEditorPane');
      i !== -1;
      i = source.indexOf('<SpatialEditorPane', i + 1)
    ) {
      offsets.push(i)
    }
    expect(offsets.length, `${SHARED_PAGE} renders no SpatialEditorPane`).toBeGreaterThan(0)
    expect(
      offsets.filter((at) => at < start || at > end),
      'a pane outside the spatial slot mounts for a markdown document too.',
    ).toEqual([])
  })

  it.each(KEEPER_PAGES)('%s renders no pane of its own', async (page) => {
    expect(
      renders(await read(page), 'SpatialEditorPane'),
      'a keeper page rendering the pane is the second call site growing back.',
    ).toBe(false)
  })
})

describe('the spatial-editor-container hook means one thing', () => {
  // The pane owns the hook, and the "built once" scan above holds the pane
  // inside the shared page's spatial slot — together they keep the old
  // guarantee (the hook only ever means "a spatial editor is mounted") with
  // the ownership the extraction moved.
  it('the pane carries it exactly once', async () => {
    expect(hookOffsets(await readPane())).toHaveLength(1)
  })

  it.each(ALL_PAGES)('%s does not spell it a second time', async (page) => {
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
const SHARED_DOCUMENT_CHROME = ['CommentsRailAside'] as const

/**
 * The inspector beside the editor (`lib/inspector.ts`): one vessel and the
 * panels the shared page puts in it. Rendered by the SHARED page even where
 * only one keeper can fill it — the Connections opener and panel are fed by
 * the daemon's backlinks through `model.connections`, and a keeper that
 * answers none gets no opener. That is the gating the model does with DATA
 * rather than with a keeper page rendering its own copy: `ConnectionsChip`
 * used to be daemon-page chrome in `MODE_SPECIFIC_CHROME`, overlaid under the
 * header as its own band, and moved here when the inspector slot took it.
 */
const SHARED_INSPECTOR_CHROME = ['InspectorPanel', 'ConnectionsChip', 'ConnectionsPanel'] as const

describe('document page canvas chrome', () => {
  it.each(SHARED_CANVAS_CHROME)('the shared page renders %s', async (chrome) => {
    expect(
      renders(await read(SHARED_PAGE), chrome),
      `${chrome} is placed by the PAGE, so a page that omits it drops the ` +
        'surface for every keeper. This is the shape that shipped canvas ' +
        'embeds and image nodes doing nothing in daemon mode.',
    ).toBe(true)
  })

  it.each(SHARED_CANVAS_CHROME)('no keeper page renders %s of its own', async (chrome) => {
    const renderedBy: string[] = []
    for (const page of KEEPER_PAGES) {
      if (renders(await read(page), chrome)) renderedBy.push(page)
    }
    expect(
      renderedBy,
      `${chrome} rendered by a keeper page is the per-keeper copy growing back — ` +
        'the other keeper then drifts without any test noticing.',
    ).toEqual([])
  })

  // The exemption list is a claim about the code, so it is checked against it —
  // and against the exact page, not merely against "not shared". Naming only
  // the sharing case leaves three ways to be wrong silently: chrome NO page
  // renders any more (a stale entry excusing nothing), chrome whose
  // ownership has flipped, and chrome that quietly became shared. Asserting
  // the owner covers all three with one comparison.
  it.each(
    Object.entries(MODE_SPECIFIC_CHROME),
  )('%s is rendered by its documented page and no other', async (chrome, { page: owner }) => {
    const renderedBy: string[] = []
    for (const page of ALL_PAGES) {
      if (renders(await read(page), chrome)) renderedBy.push(page)
    }

    expect(
      renderedBy,
      `${chrome} is exempt as ${owner}-only (${MODE_SPECIFIC_CHROME[chrome as keyof typeof MODE_SPECIFIC_CHROME].why}). ` +
        'Rendered by the shared page means it is shared now — move it to SHARED_CANVAS_CHROME. ' +
        'Rendered by no page means the entry outlived its subject. Rendered by ' +
        'the other keeper page means the exemption is describing the wrong one.',
    ).toEqual([owner])
  })

  // Neither assertion above means anything if the sources did not load.
  it('reads every page source', async () => {
    for (const page of ALL_PAGES) {
      expect((await read(page)).length, `${page} is empty`).toBeGreaterThan(10_000)
    }
  })
})

describe('document page document-level chrome', () => {
  it.each(SHARED_DOCUMENT_CHROME)('the shared page renders %s', async (chrome) => {
    expect(
      renders(await read(SHARED_PAGE), chrome),
      `${chrome} is document-level chrome (ADR-0026 decision 5): a page that ` +
        'omits it leaves that document kind with no way to reach its ' +
        'conversations at all.',
    ).toBe(true)
  })

  // The aside moved into shared chrome (CommentsRailChrome), so the page
  // renders the RAIL and the rail renders the panel — this keeps the
  // guarantee transitive rather than trusting the indirection.
  it('the shared rail chrome itself renders CommentsPanel', async () => {
    const loader = railChromeSource['../components/annotations/CommentsRailChrome.tsx']
    expect(loader, 'no source loader for CommentsRailChrome').toBeDefined()
    const source = (await loader?.()) as string
    expect(renders(source, 'CommentsPanel')).toBe(true)
  })
})

describe('document page inspector chrome', () => {
  it.each(SHARED_INSPECTOR_CHROME)('the shared page renders %s', async (chrome) => {
    expect(
      renders(await read(SHARED_PAGE), chrome),
      `${chrome} is placed by the PAGE in its one inspector slot; a page that ` +
        'omits it leaves a keeper with the opener and no panel, or the panel ' +
        'overlaid somewhere else.',
    ).toBe(true)
  })

  it.each(SHARED_INSPECTOR_CHROME)('no keeper page renders %s of its own', async (chrome) => {
    const renderedBy: string[] = []
    for (const page of KEEPER_PAGES) {
      if (renders(await read(page), chrome)) renderedBy.push(page)
    }
    expect(
      renderedBy,
      `${chrome} rendered by a keeper page is a second inspector growing back ` +
        'beside the shared one — two slots, which is what the retune ended.',
    ).toEqual([])
  })
})

/**
 * `threads=` must reach the spatial pane, and specifically inside the
 * spatial slot — the same reaches-subject discipline the "spatial editor
 * pane is built once" scan above applies to the pane itself.
 *
 * `threads=` also appears once more, on `<CommentsRailAside`, which sits
 * OUTSIDE the spatial slot by design (it is document-level chrome, not
 * canvas-level — see `SHARED_DOCUMENT_CHROME` above). So this checks that
 * SOME occurrence lands inside the slot, not that every occurrence does.
 */
describe('document page threads reach the spatial pane', () => {
  it('the shared page passes threads= inside its spatial slot', async () => {
    const source = await read(SHARED_PAGE)
    const [start, end] = spatialSlotRange(source)
    expect(start, `${SHARED_PAGE} has no spatial slot`).toBeGreaterThan(-1)

    const offsets: number[] = []
    for (let i = source.indexOf('threads='); i !== -1; i = source.indexOf('threads=', i + 1)) {
      offsets.push(i)
    }
    expect(offsets.length, `${SHARED_PAGE} never passes threads= to anything`).toBeGreaterThan(0)
    expect(
      offsets.some((at) => at >= start && at <= end),
      `${SHARED_PAGE} never passes threads= inside its spatial slot`,
    ).toBe(true)
  })
})

describe('canvas page file seams', () => {
  it('the shared page hands the shared seams to the pane', async () => {
    const source = await read(SHARED_PAGE)

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
    ...ALL_PAGES,
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
