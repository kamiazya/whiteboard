import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../index.css'
import VersionTimeline, { type VersionPreviewSession } from './VersionTimeline.js'

type FetchArgs = [RequestInfo | URL, RequestInit?]

// Which shape the mocked daemon answers with. Set inside a test body, which
// is safe because nothing fetches until that body renders.
let scenario: 'one-lane' | 'two-lanes' = 'one-lane'

const MAIN_COLOR = '#1971c2'
const FEATURE_COLOR = '#e8590c'

function mkBranchesResponse(): Response {
  const main = {
    name: 'main',
    tipFrontiers: '',
    color: MAIN_COLOR,
    createdAt: '2026-04-23T00:00:00Z',
  }
  const feature = {
    name: 'feature',
    tipFrontiers: '',
    color: FEATURE_COLOR,
    createdAt: '2026-04-24T00:00:00Z',
    baseBranch: 'main',
  }
  return new Response(
    JSON.stringify({
      head: 'main',
      branches: scenario === 'two-lanes' ? [main, feature] : [main],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function mkVersionsResponse(count = 24): Response {
  // Three rows, the last on another lane, so the ring rule has a subject.
  if (scenario === 'two-lanes') {
    const row = (id: string, label: string, branchName: string) => ({
      id,
      path: 'canvas-a',
      createdAt: '2026-04-24T00:00:00Z',
      elementCount: 12,
      label,
      auto: true,
      hasThumbnail: false,
      branchName,
      operator: { kind: 'system' as const, peerId: 'peer-system', displayName: 'auto-save' },
    })
    return new Response(
      JSON.stringify({
        versions: [
          row('v-a', 'Version 1', 'main'),
          row('v-b', 'Version 2', 'main'),
          row('v-c', 'Version 3', 'feature'),
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  const versions = Array.from({ length: count }, (_, index) => ({
    id: `v-${index}`,
    path: 'canvas-a',
    createdAt: new Date(Date.now() - index * 60_000).toISOString(),
    elementCount: 58,
    label: `Version ${index + 1}`,
    auto: true,
    hasThumbnail: false,
    branchName: 'main',
    operator: {
      kind: 'system' as const,
      peerId: 'peer-system',
      displayName: 'auto-save',
    },
  }))

  return new Response(JSON.stringify({ versions }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  scenario = 'one-lane'
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/branches')) return Promise.resolve(mkBranchesResponse())
    if (url.endsWith('/document')) {
      return Promise.resolve(
        new Response(JSON.stringify({ kind: 'spatial', canvas: { nodes: [], edges: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }
    if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

/**
 * What is left here is what needs a real engine: layout, painting, and the
 * browser's own focus model.
 *
 * The restore FLOW moved to `BrowserDocumentPage.versions.browser.test.tsx`,
 * and that is where it belongs now rather than a coverage loss — the buttons
 * that drive it are the document's chrome, which a standalone mount of this
 * panel does not have, so a test here would have had to click a copy of them
 * it built itself. The panel's own half (publishing the session, refusing a
 * second restore, carrying the error) is `VersionTimeline.test.tsx`.
 */
describe('VersionTimeline browser mode', () => {
  it('keeps the history list scrollable inside the fixed-height popover', async () => {
    const { container } = render(
      <div
        style={{
          width: '340px',
          height: '480px',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <VersionTimeline workspaceId="sess_1" path="canvas-a" />
      </div>,
    )

    await waitFor(() => {
      expect(container.textContent).toContain('Version 1')
      expect(container.textContent).toContain('Version 24')
    })

    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
    expect(viewport).toBeInstanceOf(HTMLDivElement)

    await waitFor(() => {
      expect(viewport!.clientHeight).toBeGreaterThan(0)
      expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight)
    })

    const before = viewport!.scrollTop
    viewport!.scrollTo({ top: viewport!.scrollHeight })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(viewport!.scrollTop).toBeGreaterThan(before)
  })

  it('keeps each history row keyboard-focusable, and opens the version for looking at', async () => {
    const captured: { session: VersionPreviewSession | null } = { session: null }
    render(
      <div
        style={{
          width: '340px',
          height: '480px',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <VersionTimeline
          workspaceId="sess_1"
          path="canvas-a"
          onPreview={(session) => {
            captured.session = session
          }}
        />
      </div>,
    )

    const firstVersion = await screen.findByRole('button', { name: /^Version 1\b/ })
    expect(firstVersion).toHaveAttribute('type', 'button')

    firstVersion.focus()
    expect(firstVersion).toHaveFocus()
    firstVersion.click()

    // What the panel does is PUBLISH the session; the bar that draws it is
    // the document's chrome, which this standalone mount does not have.
    await vi.waitFor(() => expect(captured.session).not.toBeNull())
    expect(captured.session?.title).toMatch(/Version 1/)
  })

  it('rings the lane HEAD is not on, names it, and keeps it out of the tab order', async () => {
    // The parts a real engine decides rather than jsdom: whether an SVG
    // circle actually paints as a ring, and whether the non-restorable row is
    // genuinely unreachable by keyboard. The row is a plain container by
    // design — not a disabled button — so "not focusable" is the whole of its
    // keyboard contract, and jsdom's focus model is too forgiving to state it.
    scenario = 'two-lanes'
    const { container } = render(
      <div
        style={{
          width: '340px',
          height: '480px',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <VersionTimeline workspaceId="sess_1" path="canvas-a" />
      </div>,
    )

    await waitFor(() => {
      expect(container.textContent).toContain('Version 3')
    })

    const dots = [...container.querySelectorAll('svg[viewBox="0 0 24 36"] circle')]
    expect(dots.length).toBe(3)
    const rings = dots.filter((c) => c.getAttribute('fill') === 'none')
    expect(rings.length).toBe(1)
    // The ring keeps its own lane's colour on the stroke, so it still reads as
    // that lane rather than as a generic "other".
    expect(rings[0]?.getAttribute('stroke')).toBe(FEATURE_COLOR)

    const laneNames = [...container.querySelectorAll('[data-testid="version-lane-name"]')]
    expect(laneNames.length).toBe(1)
    expect(laneNames[0]?.textContent).toBe('feature')

    // Two lanes, three rows, two restorable — so the feature row contributes
    // no button at all.
    const rowButtons = [...container.querySelectorAll('button')].filter((b) =>
      /^Version \d/.test(b.textContent ?? ''),
    )
    expect(rowButtons.length).toBe(2)

    const featureRow = laneNames[0]?.closest('[data-testid="version-row"]')
    expect(featureRow).not.toBeNull()
    expect(featureRow?.querySelector('button')).toBeNull()

    // And the browser refuses it focus, which is what "out of the tab order"
    // actually means at runtime.
    const shell = featureRow?.querySelector('div.rounded-xl') as HTMLElement | null
    expect(shell).not.toBeNull()
    shell?.focus()
    expect(document.activeElement).not.toBe(shell)
  })
})
