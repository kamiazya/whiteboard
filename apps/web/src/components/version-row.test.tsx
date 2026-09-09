// @vitest-environment jsdom

/**
 * What a version row SAYS.
 *
 * The old row said one fact three times and the content nowhere. Every
 * unlabelled version was titled "Auto-save", so five rows read as three
 * identical ones; the operator line added a third vocabulary (AI / Human /
 * System) whose "System" meant the same thing as that title; and a "manual"
 * badge repeated what "Human" had already said. What a reader actually looks
 * for — WHEN, and which of these is the one I named — was the part that had
 * to be inferred.
 *
 * So: the title is the person's own label when there is one and the time
 * when there is not, who did it is said once, and the fact that someone
 * marked this version deliberately is carried by the label existing.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionsBackendContext } from '../contexts/VersionsBackendContext.js'
import type { VersionsBackend } from '../lib/versions-backend.js'
import VersionTimeline from './VersionTimeline.js'

vi.mock('../lib/app-logger.js', () => ({
  getAppLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))

const NOW = Date.now()
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const ROWS = [
  {
    id: 'v3',
    label: '',
    createdAt: ago(4 * 60_000),
    auto: true,
    elementCount: 24,
    branchName: 'main',
    operator: { kind: 'ai' as const, peerId: 'daemon-x', displayName: 'Claude' },
  },
  {
    id: 'v2',
    label: 'before the rewrite',
    createdAt: ago(26 * 60_000),
    auto: false,
    elementCount: 22,
    branchName: 'main',
    operator: { kind: 'human' as const },
  },
  {
    id: 'v1',
    label: '',
    createdAt: ago(3 * 3600_000),
    auto: true,
    elementCount: 19,
    branchName: 'main',
  },
]

function backendOf(list: () => Promise<typeof ROWS>): VersionsBackend {
  return {
    list: list as never,
    loadPast: vi.fn() as never,
    save: vi.fn() as never,
    restore: vi.fn() as never,
  }
}

function renderTimeline(backend: VersionsBackend) {
  return render(
    <VersionsBackendContext.Provider value={backend}>
      <VersionTimeline workspaceId="ws" path="doc" />
    </VersionsBackendContext.Provider>,
  )
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('a version row is written from the content side', () => {
  it('titles a version by its label, and an unlabelled one by when it happened', async () => {
    renderTimeline(backendOf(async () => ROWS))
    const rows = await screen.findAllByTestId('version-row')
    expect(rows).toHaveLength(3)

    // The one someone named keeps its name.
    expect(rows[1]?.textContent).toContain('before the rewrite')
    // The unlabelled ones are told apart by time, not by all reading the
    // name of the mechanism that made them.
    expect(rows[0]?.textContent).toContain('4m ago')
    expect(rows[2]?.textContent).toContain('3h ago')
    expect(screen.queryByText('Auto-save')).toBeNull()
    expect(screen.queryByText('Manual')).toBeNull()
  })

  it('says who once, and never says "System"', async () => {
    renderTimeline(backendOf(async () => ROWS))
    await screen.findAllByTestId('version-row')

    // An agent is worth naming; an automatic checkpoint has no author to name.
    const all = screen
      .getAllByTestId('version-row')
      .map((row) => row.textContent ?? '')
      .join('\n')
    expect(all).toMatch(/Claude/)
    // Substring, not exact-text: the retired words sat inside a span beside
    // an emoji, so an exact matcher never found them and passed vacuously.
    expect(all).not.toMatch(/System/)
    expect(all).not.toMatch(/\bAI\b/)
    expect(all).not.toMatch(/Human/)
  })

  it('drops the manual badge, whose fact the label already carries', async () => {
    renderTimeline(backendOf(async () => ROWS))
    await screen.findAllByTestId('version-row')
    expect(screen.queryByText('manual')).toBeNull()
  })

  // A case pinning the lane column stood here. Lanes were the branch
  // surface's view of this list and go with it (ADR-0029); a row is now the
  // card alone.

  it('says so when the list could not be read, instead of showing stale rows in silence', async () => {
    let attempt = 0
    const backend = backendOf(async () => {
      attempt += 1
      if (attempt === 1) return ROWS
      throw new Error('offline')
    })
    const view = render(
      <VersionsBackendContext.Provider value={backend}>
        <VersionTimeline workspaceId="ws" path="doc" refreshSignal={0} />
      </VersionsBackendContext.Provider>,
    )
    await screen.findAllByTestId('version-row')
    expect(screen.queryByTestId('version-list-stale')).toBeNull()

    // Drive the refetch rather than waiting out the 15s poll.
    view.rerender(
      <VersionsBackendContext.Provider value={backend}>
        <VersionTimeline workspaceId="ws" path="doc" refreshSignal={1} />
      </VersionsBackendContext.Provider>,
    )
    // A refresh that fails leaves the rows on screen — they are still the
    // last true answer — but stops presenting them as current.
    await waitFor(() => expect(screen.getByTestId('version-list-stale')).toBeTruthy())
    expect(screen.getAllByTestId('version-row')).toHaveLength(3)
  })
})

/**
 * Which row is the one on screen.
 *
 * Opening a version swaps the whole document out for a past state and
 * renames the top bar, but the LIST said nothing — so on a screen wide
 * enough to show both, the history was a column of identical-looking rows
 * with no mark on the one being looked at. `aria-current` rather than a
 * colour alone: "the current item in a set" is exactly the fact, and it
 * reaches a screen reader, which a ring cannot.
 */
describe('the row being looked at', () => {
  function backendWithPast(): VersionsBackend {
    const backend = backendOf(async () => ROWS)
    backend.loadPast = vi.fn(async () => ({
      kind: 'spatial' as const,
      canvas: { nodes: [], edges: [] },
    })) as never
    return backend
  }

  it('is marked in the list, and it is the only one', async () => {
    renderTimeline(backendWithPast())
    const rows = await screen.findAllByTestId('version-row')

    // Nothing is open yet, so nothing claims to be current — otherwise a
    // mark that is always on some row says nothing about this one.
    for (const row of rows) {
      expect(within(row).getByRole('button').getAttribute('aria-current')).toBeNull()
    }

    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button'))

    await waitFor(() => {
      expect(
        within(rows[1] as HTMLElement)
          .getByRole('button')
          .getAttribute('aria-current'),
      ).toBe('true')
    })
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('button')
        .getAttribute('aria-current'),
    ).toBeNull()
    expect(
      within(rows[2] as HTMLElement)
        .getByRole('button')
        .getAttribute('aria-current'),
    ).toBeNull()
  })
})
