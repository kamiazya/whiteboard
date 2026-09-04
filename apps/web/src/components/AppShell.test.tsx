import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetBrowserWorkspaceIdForTests,
  setBrowserWorkspaceIdForTests,
} from '@/lib/browser-workspace-id'
import { resetInstallPromptForTests } from '@/lib/install-prompt-store'
import { resetShellStatusForTests, setShellConnection } from '@/lib/shell-status-store'
import { createUserSettingsStore } from '@/lib/user-settings-store'
import { resetSwStatusForTests } from '../pwa/sw-status-store.js'
import { AppShell, type AppShellWorkspaces } from './AppShell.js'

beforeEach(() => {
  localStorage.clear()
  resetSwStatusForTests()
  resetInstallPromptForTests()
  resetShellStatusForTests()
})

afterEach(() => {
  cleanup()
  resetBrowserWorkspaceIdForTests()
  Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true })
})

const WORKSPACES = {
  source: {
    list: () =>
      Promise.resolve([
        {
          workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          segment: 'default',
          displayName: 'Design team',
        },
        { workspaceId: '01BX5ZZKBKACTAV9WEVGEMMVRZ', segment: 'notes', displayName: 'Notes' },
      ]),
  },
  onSwitch: () => {},
}

function renderShell(
  daemonConnected: boolean,
  at = '/w/default/d/c1',
  onWorkInBrowser?: () => void,
  workspaces?: AppShellWorkspaces,
) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <AppShell
            daemon={daemonConnected}
            onWorkInBrowser={onWorkInBrowser}
            workspaces={workspaces}
          />
        ),
      },
    ],
    {
      initialEntries: [at],
    },
  )
  render(<RouterProvider router={router} />, { container: document.body })
  return router
}

describe('AppShell', () => {
  it('the mark opens its popover even where no page holds a session', async () => {
    // Replaces "brand mark links home while no page holds a session". The
    // mark IS the switcher (the "Mark as Switcher" design record), and the
    // workspace is a fact on every page — so there is always something for
    // the popover to say, and the plain-link-home shape cannot survive.
    renderShell(true, '/w/default', undefined, WORKSPACES)
    expect(screen.queryByRole('link', { name: 'Home' })).toBeNull()
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    expect(await screen.findByRole('menuitem', { name: /design team/i })).toBeTruthy()
  })

  it('offers no cross-workspace destination, because there is no such place', async () => {
    // The design record's mock ends the popover with `All documents`, and
    // that item is dropped deliberately: a whole-account view of every
    // document is a STATE this product does not have, and a menu entry is
    // the most expensive way to promise one. Leaving a document is the
    // page's own affordance (`WorkspaceTopBar`'s back), and every workspace
    // is reachable from the list above.
    renderShell(true, '/w/default', undefined, WORKSPACES)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    // The subject is PRESENT — the popover really opened — so the absence
    // below is a decision and not a menu that never rendered.
    expect(await screen.findByRole('menuitem', { name: /design team/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /all documents/i })).toBeNull()
    expect(screen.queryByTestId('shell-mark-home')).toBeNull()
  })

  it('keeps the workspace name out of the header row', async () => {
    // The design record's strip is `[mark] ALPHA <spacer> gear` and answers
    // "where does the workspace name appear at all?" with "the shell need
    // not name it". The name rides the mark's ACCESSIBLE name, so it is
    // stated without being drawn.
    renderShell(true, '/w/default', undefined, WORKSPACES)
    const trigger = await screen.findByTestId('shell-mark-trigger')
    expect(trigger.getAttribute('aria-label')).toContain('Design team')
    // Asserted on the header itself, not on the document: the popover names
    // the workspace too, and a document-wide query would pass on that.
    const header = trigger.closest('header')
    expect(header).not.toBeNull()
    expect(header?.textContent).not.toContain('Design team')
  })

  it('names and lists the workspaces inside the mark popover', async () => {
    renderShell(true, '/w/default', undefined, WORKSPACES)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    // The head states the current one; the list is what you switch to.
    // An editable field now, not a caption: the head IS where you rename it.
    expect(await screen.findByLabelText(/^workspace name$/i)).toHaveProperty('value', 'Design team')
    const current = await screen.findByRole('menuitem', { name: /design team/i })
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('menuitem', { name: /notes/i })).toBeTruthy()
  })

  it('still offers creation when the address names no workspace, which is the empty daemon', async () => {
    // A daemon holding nothing serves `/`, so the address carries no handle.
    // The switcher is the ONLY place creation is offered, so hiding it there
    // left a fresh daemon with no way to make its first workspace — while
    // this increment's whole point is that the keeper can now honour one.
    const create = vi.fn(() =>
      Promise.resolve({ workspaceId: '01BX5ZZKBKACTAV9WEVGEMMVRZ', segment: 'first' }),
    )
    renderShell(true, '/', undefined, {
      source: { list: () => Promise.resolve([]), create },
      onSwitch: () => {},
    })

    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    expect(await screen.findByRole('menuitem', { name: /new workspace/i })).toBeTruthy()
  })

  it('keeps a row document count through a rename, which only changes identity', async () => {
    // `onRenamed` is handed a WorkspaceEntry — the three identity layers and
    // nothing else — while the row it replaces is a WorkspaceRow carrying the
    // count this increment added. Replacing rather than merging dropped the
    // count until the shell happened to reload the list.
    const rename = vi.fn(() =>
      Promise.resolve({
        workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        segment: 'default',
        displayName: 'Renamed team',
      }),
    )
    renderShell(true, '/w/default', undefined, {
      source: {
        list: () =>
          Promise.resolve([
            {
              workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
              segment: 'default',
              displayName: 'Design team',
              documentCount: 7,
            },
          ]),
        rename,
      },
      onSwitch: () => {},
    })

    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    const row = await screen.findByRole('menuitem', { name: /design team/i })
    expect(row.textContent).toContain('7')

    const nameField = await screen.findByLabelText(/^workspace name$/i)
    fireEvent.change(nameField, { target: { value: 'Renamed team' } })
    fireEvent.blur(nameField)

    await waitFor(() => expect(rename).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: /renamed team/i }).textContent).toContain('7'),
    )
  })

  it('switches from the mark popover by handle, and closes it', async () => {
    const onSwitch = vi.fn()
    renderShell(true, '/w/default', undefined, { ...WORKSPACES, onSwitch })
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    fireEvent.click(await screen.findByRole('menuitem', { name: /notes/i }))
    expect(onSwitch).toHaveBeenCalledWith('notes')
  })

  it('alpha chip opens the honesty popover with a protect link', async () => {
    renderShell(true)
    fireEvent.click(screen.getByRole('button', { name: /alpha/i }))
    expect(await screen.findByText(/durability is not guaranteed/i)).toBeTruthy()
    const protect = screen.getByRole('link', { name: /protect your data/i })
    expect(protect.getAttribute('href')).toBe('/settings/data')
  })

  it('settings gear navigates to /settings carrying the entry point', () => {
    const router = renderShell(true, '/w/default/d/c1')
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(router.state.location.pathname).toBe('/settings')
    expect((router.state.location.state as { from?: string }).from).toBe('/w/default/d/c1')
  })

  it('names what the dot is about, so it reads as a task and not a warning', () => {
    renderShell(false)
    expect(screen.getByTestId('settings-nudge')).toBeTruthy()
    expect(screen.getByRole('button', { name: /settings.*(step|setup)/i })).toBeTruthy()
  })

  it('carries the nudge dot while a setup todo remains (no daemon)', () => {
    renderShell(false)
    expect(screen.getByTestId('settings-nudge')).toBeTruthy()
  })

  it('lights the nudge when the daemon page reports a live auth error', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(true) },
      configurable: true,
    })
    // Sync off IS the auth error: re-pairing is the only way out of it, so it
    // counts as disconnected for the attention dot. Transient reconnects do not.
    setShellConnection({
      state: { keeper: 'daemon', session: 'sync-off' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    renderShell(true)
    expect(await screen.findByTestId('settings-nudge')).toBeTruthy()
  })

  it('shows no nudge when everything reachable is complete', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(true) },
      configurable: true,
    })
    renderShell(true)
    // allow the persistence query to settle
    await screen.findByRole('button', { name: 'Settings' })
    expect(screen.queryByTestId('settings-nudge')).toBeNull()
  })
})

// The connection is an APP-level fact, not a document-level one: which daemon
// this browser talks to does not change when you open a different document.
// It lives beside the settings gear for the same reason the gear does — the
// document's own surface is for the document.
describe('AppShell — the mark as the connection carrier', () => {
  // Matched loosely: the CTA is two sentences across JSX lines, so an exact
  // string match would be asserting the source's line breaks, not the copy.
  const CTA = /Connect a daemon \(MCP\) for automatic checkpoints/i
  const CTA_LIMIT = /move this workspace to it from Settings/i

  it('carries no state until a page publishes a live session', () => {
    // The TRIGGER is always there now — the mark is the switcher, and the
    // workspace is a fact on every page. What is absent without a session is
    // the STATE: no keeper paint on the mark, and no session word beside the
    // workspace name in the popover's head.
    renderShell(true)
    expect(screen.getByTestId('shell-mark-trigger')).toBeTruthy()
    expect(screen.getByTestId('shell-mark').getAttribute('data-keeper')).toBeNull()
    expect(screen.getByTestId('shell-mark-trigger').getAttribute('title')).toBeNull()
  })

  it('leaves exactly one state carrier in the row, not two', async () => {
    // The row had two carriers and no subject. One carrier now answers both
    // "which workspace" and "is my work safe"; a chip left beside it would be
    // the same fact twice, which DESIGN.md's closed-set rule exists to stop.
    //
    // Counted rather than named: asserting the OLD test id is absent would
    // pass just as well if a replacement chip were added under a new one, and
    // a guard that cannot see its subject is no guard.
    setShellConnection({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    renderShell(true)
    const header = (await screen.findByTestId('shell-mark-trigger')).closest('header')
    expect(header).not.toBeNull()
    const carriers = header?.querySelectorAll(
      '[data-testid="shell-mark-cap"], [data-testid="state-dot"]',
    )
    expect(carriers?.length).toBe(1)
  })

  it.each([
    ['browser-kept', { keeper: 'browser' }, /browser/i],
    ['synced', { keeper: 'daemon', session: 'synced' }, /synced/i],
    ['reconnecting', { keeper: 'daemon', session: 'reconnecting' }, /reconnecting/i],
    ['sync-off', { keeper: 'daemon', session: 'sync-off' }, /sync off/i],
  ] as const)('renders the %s state the page published', async (_name, state, label) => {
    setShellConnection({ state, daemonBaseUrl: 'http://127.0.0.1:3099' })
    renderShell(state.keeper === 'daemon')
    // The mark has no room for the word, so the accessible name carries it —
    // and it must, because two of these four states share a tone.
    expect((await screen.findByTestId('shell-mark-trigger')).getAttribute('aria-label')).toMatch(
      label,
    )
  })

  it('follows the page as its session changes, without a remount', async () => {
    setShellConnection({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    renderShell(true)
    expect((await screen.findByTestId('shell-mark-trigger')).getAttribute('aria-label')).toMatch(
      /synced/i,
    )

    act(() =>
      setShellConnection({
        state: { keeper: 'daemon', session: 'reconnecting' },
        daemonBaseUrl: 'http://127.0.0.1:3099',
      }),
    )
    expect(screen.getByTestId('shell-mark-trigger').getAttribute('aria-label')).toMatch(
      /reconnecting/i,
    )
    expect(screen.getByTestId('shell-mark').getAttribute('data-session')).toBe('reconnecting')

    // Leaving the document takes the CLAIM with it: nothing on an index page
    // is synced, and a latched mark would say otherwise. The trigger stays —
    // it is the switcher, and the workspace does not stop existing — so what
    // has to go is the paint and the word, not the control.
    act(() => setShellConnection(null))
    expect(screen.getByTestId('shell-mark-trigger')).toBeTruthy()
    expect(screen.getByTestId('shell-mark').getAttribute('data-session')).toBeNull()
    expect(screen.getByTestId('shell-mark-trigger').getAttribute('aria-label')).not.toMatch(
      /reconnecting/i,
    )
  })

  it('carries the capability CTA inside the Local popover, not in page chrome', async () => {
    setShellConnection({ state: { keeper: 'browser' } })
    renderShell(false)
    expect(screen.queryByText(CTA)).toBeNull()

    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    expect(await screen.findByText(CTA)).toBeTruthy()
    // The CTA points at where the move lives (Settings manages; the chip
    // only reports and nudges) — whole-workspace promotion is implemented,
    // so the old "import them one at a time" disclaimer would now be false.
    expect(screen.getByText(CTA_LIMIT)).toBeTruthy()
  })

  // Slice 8's honest-detach floor: a cold load whose silent renewal fails
  // falls back to the browser flow with the stored daemon still configured.
  // For a workspace that was MOVED to that daemon, resuming keeper duties
  // silently would hide that edits made here diverge from the daemon copy —
  // so the browser popover discloses the move instead of claiming nothing.
  it('the browser popover discloses a recorded move to the still-configured daemon', async () => {
    setBrowserWorkspaceIdForTests('ws-src')
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: 'http://127.0.0.1:3099' },
      migration: {
        ...current.migration,
        promotion: {
          at: '2026-08-28T12:00:00.000Z',
          daemonBaseUrl: 'http://127.0.0.1:3099',
          workspaceId: 'ws-a',
          sourceWorkspaceId: 'ws-src',
          ok: true,
          promotedCount: 2,
          shadowedPaths: [],
          blobsMissing: [],
          blobsFailed: [],
        },
      },
    }))
    setShellConnection({ state: { keeper: 'browser' } })
    renderShell(false)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    const notice = await screen.findByTestId('promoted-elsewhere-notice')
    expect(notice.textContent).toMatch(/moved to the daemon/i)
    expect(notice.textContent).toMatch(/stay in this browser/i)
    // Reachability is unknown from here, so the copy must not claim it.
    expect(notice.textContent).not.toMatch(/unreachable|offline|cannot be reached/i)
  })

  it('the daemon popover states the replica cache for the active workspace', async () => {
    // ADR-0023: a daemon workspace this browser holds a replica of says so
    // where the workspace is named — the popover — not in a settings corner.
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        replicas: {
          '01ARZ3NDEKTSV4RRFFQ69G5FAV': {
            daemonBaseUrl: 'http://127.0.0.1:3099',
            syncedAt: '2026-09-01T12:00:00.000Z',
          },
        },
      },
    }))
    setShellConnection({ state: { keeper: 'daemon', session: 'synced' } })
    renderShell(true, '/w/default', undefined, WORKSPACES)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    const notice = await screen.findByTestId('replica-cache-notice')
    expect(notice.textContent).toMatch(/cached in this browser/i)
  })

  it('no replica claim for a daemon workspace this browser holds no replica of', async () => {
    setShellConnection({ state: { keeper: 'daemon', session: 'synced' } })
    renderShell(true, '/w/default', undefined, WORKSPACES)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    // Subject presence: the popover named the workspace, so the absence is a
    // decision, not an unopened menu.
    expect(await screen.findByRole('menuitem', { name: /design team/i })).toBeTruthy()
    expect(screen.queryByTestId('replica-cache-notice')).toBeNull()
  })

  it('a workspace that was not the one moved gets no move disclosure', async () => {
    // The marker is per-workspace: since ADR-0019 this browser keeps many
    // workspaces, and telling a never-promoted one "this workspace has been
    // moved" is a false claim about ITS data.
    setBrowserWorkspaceIdForTests('ws-other')
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: 'http://127.0.0.1:3099' },
      migration: {
        ...current.migration,
        promotion: {
          at: '2026-08-28T12:00:00.000Z',
          daemonBaseUrl: 'http://127.0.0.1:3099',
          workspaceId: 'ws-a',
          sourceWorkspaceId: 'ws-src',
          ok: true,
          promotedCount: 2,
          shadowedPaths: [],
          blobsMissing: [],
          blobsFailed: [],
        },
      },
    }))
    setShellConnection({ state: { keeper: 'browser' } })
    renderShell(false)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    await screen.findByText(CTA)
    expect(screen.queryByTestId('promoted-elsewhere-notice')).toBeNull()
  })

  it('a legacy record that never named its source shows no disclosure', async () => {
    // Pre-per-workspace records cannot say WHICH browser workspace moved, so
    // showing the banner on whichever is active would be the misfire this
    // field exists to end. Staying silent about an unknown is the honest
    // floor.
    setBrowserWorkspaceIdForTests('ws-src')
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: 'http://127.0.0.1:3099' },
      migration: {
        ...current.migration,
        promotion: {
          at: '2026-08-28T12:00:00.000Z',
          daemonBaseUrl: 'http://127.0.0.1:3099',
          workspaceId: 'ws-a',
          ok: true,
          promotedCount: 2,
          shadowedPaths: [],
          blobsMissing: [],
          blobsFailed: [],
        },
      },
    }))
    setShellConnection({ state: { keeper: 'browser' } })
    renderShell(false)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    await screen.findByText(CTA)
    expect(screen.queryByTestId('promoted-elsewhere-notice')).toBeNull()
  })

  it('no move disclosure without a matching promotion record', async () => {
    // A promotion recorded against a daemon the browser no longer uses (or
    // none at all) is not this connection's story to tell.
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: 'http://127.0.0.1:3099' },
      migration: {
        ...current.migration,
        promotion: {
          at: '2026-08-28T12:00:00.000Z',
          daemonBaseUrl: 'http://127.0.0.1:4200',
          workspaceId: 'ws-a',
          ok: true,
          promotedCount: 2,
          shadowedPaths: [],
          blobsMissing: [],
          blobsFailed: [],
        },
      },
    }))
    setShellConnection({ state: { keeper: 'browser' } })
    renderShell(false)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    await screen.findByText(CTA)
    expect(screen.queryByTestId('promoted-elsewhere-notice')).toBeNull()
  })

  it('offers the escape to the browser from the sync-off popover', async () => {
    const onWorkInBrowser = vi.fn()
    setShellConnection({
      state: { keeper: 'daemon', session: 'sync-off' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    renderShell(true, '/w/ws/d/a.canvas', onWorkInBrowser)

    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    fireEvent.click(await screen.findByRole('button', { name: /work in this browser instead/i }))
    expect(onWorkInBrowser).toHaveBeenCalledTimes(1)
  })

  // The management action moved to Settings (see SettingsPage.test.tsx). What
  // the shell keeps is the report and the pointer to where the action lives.
  it('points at Settings rather than carrying the management action itself', async () => {
    setShellConnection({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    renderShell(true)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    await waitFor(() => expect(screen.getByTestId('shell-mark-popover')).toBeTruthy())

    expect(screen.queryByTestId('connection-disconnect')).toBeNull()
    expect(screen.getByRole('link', { name: /manage in settings/i }).getAttribute('href')).toBe(
      '/settings/connections',
    )
  })
})

describe('AppShell — a count the keeper can only produce expensively', () => {
  const COUNTED = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

  it('does not ask for counts while the popover is closed', async () => {
    // THE guard for this whole design. The browser keeper answers `counts()`
    // by loading loro-crdt's WASM (3039.5 KB), so a call on the shell's own
    // render path would put it on every startup — which is exactly what the
    // merged LCP floor exists to refuse. The popover's content is what asks,
    // and Radix does not mount content until it opens.
    const counts = vi.fn(() => Promise.resolve(new Map([[COUNTED, 4]])))
    renderShell(true, '/w/default', undefined, {
      ...WORKSPACES,
      source: { ...WORKSPACES.source, counts },
    })
    // Wait for the shell's OWN list to land, so this asserts against a shell
    // that has finished its startup work rather than one still doing it.
    // Waited on the MARK'S ACCESSIBLE NAME, which the shell can only write
    // once `list()` resolved. Without a wait that reaches the loaded state,
    // this would assert against a shell still starting up and pass whatever
    // the code did.
    expect(await screen.findByLabelText(/workspace: design team/i)).toBeTruthy()
    expect(counts).not.toHaveBeenCalled()
  })

  it('shows the count on the row once opening the popover has bought it', async () => {
    const counts = vi.fn(() => Promise.resolve(new Map([[COUNTED, 4]])))
    renderShell(true, '/w/default', undefined, {
      ...WORKSPACES,
      source: { ...WORKSPACES.source, counts },
    })
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    const row = await screen.findByRole('menuitem', { name: /design team/i })
    // The row is readable BEFORE the count arrives — the name is what a
    // person opened this for, and the number is an ornament on it.
    expect(row.textContent).toMatch(/design team/i)
    await waitFor(() => expect(row.textContent).toMatch(/4/))
    expect(counts).toHaveBeenCalledTimes(1)
  })
})
