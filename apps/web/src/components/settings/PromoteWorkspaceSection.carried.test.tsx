/**
 * The move's report and demote gate, with the transfer itself stubbed: what
 * the section does with a promotion outcome — whether the browser copy goes,
 * what the stored record keeps of what was left behind, and how a later
 * visit names the daemon workspace. The real-IndexedDB flow is
 * PromoteWorkspaceSection.carried.browser.test.tsx.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { demoteBrowserWorkspace, replicaCarriesAll } from '../../lib/demote-browser-workspace.js'
import { type PromoteWorkspaceResult, promoteWorkspace } from '../../lib/promote-workspace.js'
import { cacheDaemonWorkspace } from '../../lib/replica-cache.js'
import {
  createUserSettingsStore,
  type PromotionResultRecord,
  STORAGE_KEY,
} from '../../lib/user-settings-store.js'
import { jsonResponse } from '../../test-utils/json-response.js'
import { PromoteWorkspaceSection } from './PromoteWorkspaceSection.js'
// The move path loads this module with `await import()` once the promotion
// answers, and it is the one module on that path the file does not mock.
// Left cold, its graph's transform-and-load is charged to the first test's
// `findBy*` and per-test timeout, which a loaded machine outlasts — and the
// timed-out handler then runs on into the next test's mocks. Loaded here, it
// is paid at collection, outside every timer.
import '../../lib/browser-workspace-removal.js'

vi.mock('../../lib/promote-workspace.js', () => ({
  countBrowserWorkspaceDocuments: vi.fn(async () => 2),
  promoteWorkspace: vi.fn(),
}))
vi.mock('../../lib/browser-workspace-docs.js', () => ({ BrowserWorkspaceDocs: class {} }))
vi.mock('../../lib/fold-workspace.js', () => ({ foldOrServeTheTree: vi.fn(async () => {}) }))
vi.mock('../../lib/replica-cache.js', () => ({ cacheDaemonWorkspace: vi.fn() }))
vi.mock('../../lib/demote-browser-workspace.js', () => ({
  demoteBrowserWorkspace: vi.fn(async () => {}),
  replicaCarriesAll: vi.fn(async () => true),
}))

const BASE = 'http://127.0.0.1:3099'
const DAEMON = { baseUrl: BASE }

type OkOutcome = Extract<PromoteWorkspaceResult, { kind: 'ok' }>

function outcome(overrides: Partial<OkOutcome> = {}): OkOutcome {
  return {
    kind: 'ok',
    sourceWorkspaceId: 'browser-ws',
    promotedDocumentIds: ['d1', 'd2'],
    shadowedPaths: [],
    blobs: { transferred: [], missing: [], failed: [] },
    leftBehind: [],
    versionsLeftBehind: 0,
    ...overrides,
  } as OkOutcome
}

/** The daemon's workspace listing, the only route the section reads itself. */
const daemonFetch = vi.fn(async () =>
  jsonResponse({ workspaces: [{ workspaceId: 'ws-a', displayName: 'Team notes' }] }),
) as unknown as typeof globalThis.fetch

async function move(
  result: OkOutcome,
  baseFetch: typeof globalThis.fetch = daemonFetch,
): Promise<HTMLElement> {
  vi.mocked(promoteWorkspace).mockResolvedValue(result)
  render(
    <PromoteWorkspaceSection
      daemon={DAEMON}
      settingsStore={createUserSettingsStore()}
      baseFetch={baseFetch}
      reload={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByTestId('promote-workspace-open'))
  fireEvent.click(await screen.findByTestId('promote-confirm'))
  return screen.findByTestId('promote-last-result')
}

function storedPromotion(): PromotionResultRecord {
  const promotion = createUserSettingsStore().load().migration.promotion
  if (promotion === undefined) throw new Error('expected a stored promotion record')
  return promotion
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY)
  vi.mocked(cacheDaemonWorkspace).mockResolvedValue({
    kind: 'ok',
    syncedAt: '2026-01-01T00:00:00.000Z',
    documentCount: 2,
    syncedFrontier: 'frontier',
  } as Awaited<ReturnType<typeof cacheDaemonWorkspace>>)
})

afterEach(() => {
  cleanup()
  localStorage.removeItem(STORAGE_KEY)
  vi.clearAllMocks()
})

describe('PromoteWorkspaceSection, what the move left behind', () => {
  it('removes the browser copy once nothing was left behind, naming the workspace by its name', async () => {
    // The listing answers the confirmation only, so the name has to come
    // from the target the move was made into, not from a later read.
    const listOnce = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ workspaces: [{ workspaceId: 'ws-a', displayName: 'Team notes' }] }),
      )
      .mockRejectedValue(new Error('offline')) as unknown as typeof globalThis.fetch
    const result = await move(outcome(), listOnce)
    expect(result.textContent).toMatch(/Moved 2 documents to daemon workspace "Team notes"/)
    expect(result.textContent).toMatch(/browser copy was removed/)
    expect(result.textContent).not.toMatch(/Not moved yet/)
    expect(demoteBrowserWorkspace).toHaveBeenCalledWith('browser-ws')
    const stored = storedPromotion()
    expect(stored.ok && stored.leftBehind).toBeUndefined()
  })

  it('keeps the browser copy and says what did not move when the trash or versions stayed', async () => {
    const result = await move(
      outcome({ leftBehind: ['1 trashed document did not reach the daemon'] }),
    )
    expect(result.textContent).toMatch(/Not moved yet: 1 trashed document did not reach the daemon/)
    expect(result.textContent).toMatch(/original copy is kept in this browser/)
    expect(replicaCarriesAll).not.toHaveBeenCalled()
    expect(demoteBrowserWorkspace).not.toHaveBeenCalled()
  })

  it('says how many saved versions stayed behind past the check budget, and keeps the copy', async () => {
    const sentence =
      '2 older saved versions: checking more would take the daemon longer than one move allows'
    const result = await move(outcome({ leftBehind: [sentence], versionsLeftBehind: 2 }))
    expect(result.textContent).toContain(`Not moved yet: ${sentence}`)
    expect(result.textContent).toMatch(/original copy is kept in this browser/)
    expect(demoteBrowserWorkspace).not.toHaveBeenCalled()
  })

  it('keeps the browser copy while a referenced image was missing', async () => {
    const result = await move(
      outcome({ blobs: { transferred: [], missing: ['asset:gone'], failed: [] } }),
    )
    expect(result.textContent).toMatch(/1 referenced image was already missing/)
    expect(demoteBrowserWorkspace).not.toHaveBeenCalled()
  })

  it('records each failed image once per distinct reason, and keeps the browser copy', async () => {
    const result = await move(
      outcome({
        blobs: {
          transferred: [],
          missing: [],
          failed: [
            { fileId: 'f1', reason: 'Too large.' },
            { fileId: 'f2', reason: 'Too large.' },
          ],
        },
      }),
    )
    expect(result.textContent).toMatch(/2 images could not be moved: Too large\./)
    const stored = storedPromotion()
    if (!stored.ok) throw new Error('expected an ok promotion record')
    expect(stored.blobsFailed).toEqual(['f1', 'f2'])
    expect(stored.blobFailureReasons).toEqual(['Too large.'])
    expect(demoteBrowserWorkspace).not.toHaveBeenCalled()
  })

  it('clips a long left-behind list to what the settings record holds, rather than losing it', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `${i}:${'x'.repeat(600)}`)
    await move(outcome({ leftBehind: long }))
    const stored = storedPromotion()
    if (!stored.ok) throw new Error('expected an ok promotion record')
    expect(stored.leftBehind).toHaveLength(100)
    expect(stored.leftBehind?.[0]).toBe(long[0]?.slice(0, 500))
    expect(stored.localCopyRemoved).toBe(false)
  })
})

describe('PromoteWorkspaceSection, the stored report on a later visit', () => {
  const record = (overrides: Partial<PromotionResultRecord> = {}) =>
    ({
      at: '2026-01-01T00:00:00.000Z',
      daemonBaseUrl: BASE,
      workspaceId: 'ws-a',
      ok: true,
      promotedCount: 1,
      shadowedPaths: [],
      blobsMissing: [],
      blobsFailed: [],
      localCopyRemoved: false,
      leftBehind: ['1 saved version did not reach the daemon'],
      ...overrides,
    }) as PromotionResultRecord

  function seed(promotion: PromotionResultRecord) {
    const store = createUserSettingsStore()
    store.update((current) => ({ ...current, migration: { ...current.migration, promotion } }))
    return store
  }

  it("reads the workspace's name back from the daemon and still says why the copy stayed", async () => {
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={seed(record())}
        baseFetch={daemonFetch}
      />,
    )
    const result = await screen.findByTestId('promote-last-result')
    expect(result.textContent).toMatch(/Not moved yet: 1 saved version did not reach the daemon/)
    await vi.waitFor(() =>
      expect(screen.getByTestId('promote-last-result').textContent).toMatch(
        /Moved 1 document to daemon workspace "Team notes"/,
      ),
    )
  })

  it('names a failed move by the workspace name too', async () => {
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={seed({
          at: '2026-01-01T00:00:00.000Z',
          daemonBaseUrl: BASE,
          workspaceId: 'ws-a',
          ok: false,
          reason: 'the daemon refused',
        })}
        baseFetch={daemonFetch}
      />,
    )
    await vi.waitFor(() =>
      expect(screen.getByTestId('promote-last-result').textContent).toBe(
        'Move to daemon workspace "Team notes" failed: the daemon refused',
      ),
    )
    expect(screen.queryByTestId('promote-reload')).toBeNull()
  })

  it('shows no report recorded under another daemon', () => {
    render(
      <PromoteWorkspaceSection
        daemon={{ baseUrl: 'http://127.0.0.1:4000' }}
        settingsStore={seed(record())}
        baseFetch={daemonFetch}
      />,
    )
    expect(screen.queryByTestId('promote-last-result')).toBeNull()
  })

  it('says what a move would carry before a daemon is connected', () => {
    render(<PromoteWorkspaceSection settingsStore={createUserSettingsStore()} />)
    expect(screen.getByLabelText('This workspace').textContent).toMatch(
      /Connect a daemon to move the workspace this browser keeps onto it — documents, the Trash, saved versions and images\./,
    )
  })
})
