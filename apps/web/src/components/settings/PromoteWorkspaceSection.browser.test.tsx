/**
 * Slice 6 acceptance for the promote UI, one test per criterion from the
 * initiative plan: focus trap, live-announced progress, persistent (never
 * toast-only) result, no internal vocabulary — plus the cross-feature
 * invariant that promotion preserves document identity end to end.
 *
 * web-browser layer on purpose: focus trapping and dialog behavior are real
 * pointer/focus risk, and the seeded workspace lives in real IndexedDB so the
 * section's count and the posted bytes come from the production read path.
 */
import {
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { getBrowserWorkspaceId } from '../../lib/browser-workspace-id.js'
import { DocumentFileStore } from '../../lib/document-file-store.js'
import { FoldingBrowserIndex } from '../../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../../lib/idb-document-index.js'
import { ensureLocalWorkspace } from '../../lib/local-document-summary.js'
import { LoroStore } from '../../lib/loro-store.js'
import { createUserSettingsStore, STORAGE_KEY } from '../../lib/user-settings-store.js'
import { seedWorkspaceDocumentContent } from '../../lib/workspace-content.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { PromoteWorkspaceSection } from './PromoteWorkspaceSection.js'

claimIsolatedWhiteboardDb('promote-section')

const BASE = 'http://127.0.0.1:3099'
const DAEMON = { baseUrl: BASE, token: 'tok-1' }

interface StubOptions {
  updateDelayMs?: number
  putDelayMs?: number
  /** An update that stays in flight until the test releases it. */
  updateGate?: Promise<void>
  failUpdateStatus?: number
  workspaces?: { workspaceId: string; segment?: string; displayName?: string }[]
}

/** The three daemon routes the flow touches, answering from `target`. */
function daemonStub(target: LoroDoc, opts: StubOptions = {}): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/workspaces') && (init?.method ?? 'GET') === 'GET') {
      return Response.json({
        workspaces: opts.workspaces ?? [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      })
    }
    if (url.endsWith('/workspace-document/update') && init?.method === 'POST') {
      if (opts.updateDelayMs) await new Promise((r) => setTimeout(r, opts.updateDelayMs))
      if (opts.updateGate) await opts.updateGate
      if (opts.failUpdateStatus) {
        return Response.json(
          { title: `Workspace "ws-a" not found` },
          { status: opts.failUpdateStatus },
        )
      }
      target.import(new Uint8Array(init.body as Uint8Array))
      return Response.json({ ok: true })
    }
    if (url.includes('/file/') && init?.method === 'PUT') {
      if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs))
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/documents')) {
      const documents = readWorkspaceDocuments(target).map((entry) => ({
        path: entry.path,
        id: entry.documentId,
        kind: entry.kind,
        updatedAt: new Date().toISOString(),
      }))
      return Response.json({ documents })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
}

async function seedTwoDocuments(): Promise<{ roadmapId: string; sketchId: string }> {
  const index = new FoldingBrowserIndex()
  await ensureLocalWorkspace(index)
  const roadmap = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: 'notes/roadmap',
    kind: 'markdown',
  })
  const sketch = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path: 'sketch',
    kind: 'spatial',
  })
  return { roadmapId: roadmap.documentId, sketchId: sketch.documentId }
}

/** Gives the sketch a stored image, so promotion has a real blob phase. */
async function seedImageOnSketch(sketchId: string): Promise<void> {
  await new DocumentFileStore().put('img-1', {
    mimeType: 'image/png',
    blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    created: Date.now(),
  })
  const content = new LoroDoc()
  writeSpatialCanvas(content, {
    nodes: [
      { id: 'img', type: 'file', file: newImageRef('img-1'), x: 0, y: 0, width: 5, height: 5 },
    ],
    edges: [],
  })
  expect(
    await seedWorkspaceDocumentContent(
      sketchId,
      new Uint8Array(content.export({ mode: 'snapshot' })),
    ),
  ).toBe(true)
}

/**
 * A document as an older build left it: an index row plus per-document Loro
 * bytes, never absorbed into the workspace record. Exactly what a session
 * that deep-links straight to Settings sees before any page ran the fold.
 */
async function seedPreFoldDocument(path: string): Promise<string> {
  const index = new IdbDocumentIndex()
  await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() })
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path,
    kind: 'spatial',
  })
  const doc = new LoroDoc()
  doc
    .getMap('nodes')
    .set('n1', { id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'pre-fold' })
  doc.commit()
  await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))
  return entry.documentId
}

/**
 * An update the test releases, rather than one that finishes on a timer.
 *
 * A test that has to observe the RUNNING phase is racing the flow it started:
 * the progress element is on screen only until the update resolves, and the
 * driver round trip that `userEvent.click` waits out afterwards is charged to
 * that same window. A delay makes the window wide, not certain — and it is a
 * wall-clock number sitting next to a cost that grows with the run (the same
 * file's tests were measured at 1.5s alone and 30s+ with the whole browser
 * project in flight). Held instead, nothing about the machine can close the
 * window early.
 */
function heldUpdate(): { gate: Promise<void>; release: () => void } {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = () => {
      resolve()
    }
  })
  return { gate, release: () => release() }
}

const NO_INTERNAL_VOCABULARY = /loro|crdt|oplog|snapshot/i

beforeEach(async () => {
  // Only the key this component reads — a blanket clear() would wipe theme
  // and view-mode state out from under concurrently running files
  // (view-mode-isolation.test.ts guards exactly this).
  localStorage.removeItem(STORAGE_KEY)
  await clearWhiteboardDb()
})
afterEach(cleanup)

describe('PromoteWorkspaceSection', () => {
  it('confirmation dialog traps focus and Escape returns it to the trigger', async () => {
    await seedTwoDocuments()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc())}
        reload={vi.fn()}
      />,
    )
    const trigger = screen.getByTestId('promote-workspace-open')
    await userEvent.click(trigger)
    const dialog = await screen.findByTestId('promote-dialog')

    // Tab past the end and Shift+Tab past the start: focus never leaves.
    for (let i = 0; i < 8; i++) {
      await userEvent.keyboard('{Tab}')
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    for (let i = 0; i < 8; i++) {
      await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
      expect(dialog.contains(document.activeElement)).toBe(true)
    }

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('promote-dialog')).toBeNull())
    // Focus restoration runs after the close animation settles.
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('progress is a polite live region whose text updates before completion', async () => {
    const { sketchId } = await seedTwoDocuments()
    // A real blob phase (a stored image behind a slowed upload) is what makes
    // the second phase text observable rather than a one-frame flicker.
    await seedImageOnSketch(sketchId)
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), { updateDelayMs: 150, putDelayMs: 400 })}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await userEvent.click(await screen.findByTestId('promote-confirm'))

    const progress = await screen.findByTestId('promote-progress')
    expect(progress.getAttribute('role')).toBe('status')
    expect(progress.getAttribute('aria-live')).toBe('polite')
    expect(progress.textContent).toMatch(/moving documents and their history/i)
    // The text advances with the transfer's real phases, before the flow ends.
    await waitFor(() => {
      expect(screen.getByTestId('promote-progress').textContent).toMatch(/referenced images/i)
    })
    await screen.findByTestId('promote-last-result')
  })

  it('the result persists across a remount and ids resolve unchanged — never a toast', async () => {
    const { roadmapId, sketchId } = await seedTwoDocuments()
    const target = new LoroDoc()
    const view = render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(target)}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    const result = await screen.findByTestId('promote-last-result')
    expect(result.textContent).toMatch(/moved 2 documents to daemon workspace "ws-a"/i)

    // Identity invariant: the same ids resolve on the daemon target, and the
    // browser keeper still resolves them too (the copy here stays).
    expect(resolveWorkspaceDocumentById(target, roadmapId)).not.toBeNull()
    expect(resolveWorkspaceDocumentById(target, sketchId)).not.toBeNull()
    const stillHere = await new FoldingBrowserIndex().listDocuments({
      workspaceId: getBrowserWorkspaceId(),
    })
    expect([...stillHere.map((d) => d.documentId)].sort()).toEqual([roadmapId, sketchId].sort())

    // Not a toast: no alert/transient surface anywhere, and the report is
    // still standing after a full unmount/remount (a later Settings visit).
    expect(document.querySelector('[role="alert"]')).toBeNull()
    view.unmount()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(target)}
        reload={vi.fn()}
      />,
    )
    expect((await screen.findByTestId('promote-last-result')).textContent).toMatch(
      /moved 2 documents/i,
    )
    expect(screen.getByTestId('promote-reload')).toBeTruthy()
  })

  it('every user-facing string avoids internal vocabulary, in success and failure alike', async () => {
    await seedTwoDocuments()
    const failing = render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), { failUpdateStatus: 404 })}
        reload={vi.fn()}
      />,
    )
    expect(document.body.textContent).not.toMatch(NO_INTERNAL_VOCABULARY)
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await screen.findByTestId('promote-dialog')
    expect(document.body.textContent).not.toMatch(NO_INTERNAL_VOCABULARY)
    await userEvent.click(screen.getByTestId('promote-confirm'))
    const failure = await screen.findByTestId('promote-last-result')
    expect(failure.textContent).toMatch(/failed/i)
    expect(document.body.textContent).not.toMatch(NO_INTERNAL_VOCABULARY)
    failing.unmount()

    localStorage.removeItem(STORAGE_KEY)
    const running = heldUpdate()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), { updateGate: running.gate })}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    await screen.findByTestId('promote-progress')
    expect(
      screen.queryByTestId('promote-last-result'),
      'the update is still held, so the running phase is what is being read here — if the flow has already finished, this case is back to racing it',
    ).toBeNull()
    expect(document.body.textContent).not.toMatch(NO_INTERNAL_VOCABULARY)
    running.release()
    await screen.findByTestId('promote-last-result')
    expect(document.body.textContent).not.toMatch(NO_INTERNAL_VOCABULARY)
  })

  it('the success surface narrates the reload instead of navigating by itself', async () => {
    await seedTwoDocuments()
    const reload = vi.fn()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc())}
        reload={reload}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    await screen.findByTestId('promote-last-result')
    // Success alone navigates nowhere — the reload is an offer, taken by the
    // user, and its label says where it leads.
    expect(reload).not.toHaveBeenCalled()
    const button = screen.getByTestId('promote-reload')
    expect(button.textContent).toMatch(/reload and continue from the daemon/i)
    await userEvent.click(button)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("a result recorded under one daemon is not shown as another daemon's", async () => {
    await seedTwoDocuments()
    const view = render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc())}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    await screen.findByTestId('promote-last-result')
    view.unmount()

    // Same browser, different daemon: the stored result (and its reload
    // offer) belongs to the first daemon and must not read as this one's.
    render(
      <PromoteWorkspaceSection
        daemon={{ baseUrl: 'http://127.0.0.1:4200', token: 'tok-2' }}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc())}
        reload={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('promote-last-result')).toBeNull()
    expect(screen.queryByTestId('promote-reload')).toBeNull()
  })

  // DESIGN.md: "Raw identifiers are not chrome." A named daemon workspace
  // shows its name in the target selector; only an unnamed one falls back to
  // its identifier, the same fallback a document without a display name uses.
  it('the target selector shows workspace names, and an id only as the unnamed fallback', async () => {
    const { roadmapId } = await seedTwoDocuments()
    const target = new LoroDoc()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(target, {
          workspaces: [{ workspaceId: 'ws-a', displayName: 'Team notes' }, { workspaceId: 'ws-b' }],
        })}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    const select = await screen.findByTestId('promote-target')
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent)
    expect(labels).toEqual(['Team notes', 'ws-b'])
    // The value stays the identifier: names are chrome, ids are the address.
    await userEvent.selectOptions(select, 'Team notes')
    await userEvent.click(screen.getByTestId('promote-confirm'))
    await screen.findByTestId('promote-last-result')
    expect(resolveWorkspaceDocumentById(target, roadmapId)).not.toBeNull()
  })

  // The other half of the same DESIGN.md sentence: a single-choice selector
  // renders nothing at all — one workspace is a fact, not a decision.
  it('a single daemon workspace renders as its name, not a one-option selector', async () => {
    await seedTwoDocuments()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), {
          workspaces: [{ workspaceId: 'ws-a', displayName: 'Team notes' }],
        })}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await screen.findByTestId('promote-dialog')
    expect(screen.queryByTestId('promote-target')).toBeNull()
    const single = screen.getByTestId('promote-target-single')
    expect(single.textContent).toMatch(/team notes/i)
    await userEvent.click(screen.getByTestId('promote-confirm'))
    expect((await screen.findByTestId('promote-last-result')).textContent).toMatch(/moved 2/i)
  })

  it('a workspace named only by its segment shows the segment, never its ULID', async () => {
    // The middle of ADR-0019's three layers. This selector reached straight
    // past it for `displayName ?? workspaceId`, so a workspace whose owner
    // named it in the URL but never gave it a display name read back here as
    // 26 characters nobody chose.
    await seedTwoDocuments()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), {
          workspaces: [{ workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', segment: 'design-team' }],
        })}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await screen.findByTestId('promote-dialog')
    const single = screen.getByTestId('promote-target-single')
    expect(single.textContent).toBe('design-team')
    expect(single.textContent).not.toContain('01ARZ3')
  })

  // The section can be a session's FIRST surface (deep-link/reload straight
  // to Settings): no browser page has run the startup fold, so the workspace
  // record does not hold pre-fold legacy documents yet. The count and the
  // transfer must still include them — silently omitting a document from a
  // data-migration UI is the data-loss shape this pins.
  it('counts and moves a document held only by pre-fold records, with no page mounted first', async () => {
    const legacyId = await seedPreFoldDocument('legacy/roadmap')
    const target = new LoroDoc()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(target)}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    const dialog = await screen.findByTestId('promote-dialog')
    expect(dialog.textContent).toMatch(/all 1 document\b/i)
    await userEvent.click(screen.getByTestId('promote-confirm'))
    await screen.findByTestId('promote-last-result')
    expect(resolveWorkspaceDocumentById(target, legacyId)).not.toBeNull()
  })

  it('stays discoverable but disabled with no daemon connected', async () => {
    render(<PromoteWorkspaceSection settingsStore={createUserSettingsStore()} />)
    const trigger = screen.getByTestId('promote-workspace-open')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    expect(document.body.textContent).toMatch(/connect a daemon/i)
  })
})
