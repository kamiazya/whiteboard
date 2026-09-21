/**
 * ADR-0023's offline page over REAL IndexedDB: the replica record's list,
 * markdown bodies (EDITABLE — decision 3's data plane), and spatial
 * canvases (still read-only). What must stay pinned from the read-only
 * era: no index row is ever written, no record is ever minted, and a
 * visit that edits nothing leaves the record byte-identical.
 */

import { forgetAll } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  readSpatialCanvas,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import {
  fillNodeEditor,
  nodeEditorContent,
} from '../components/spatial-editor/node-editor-test-utils.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { REPLICA_STATE_COPY } from '../lib/replica-state-copy.js'
import { connectReplicaKeeper, markReplica } from '../lib/replica-store.js'
import { REPLICA_TIER_COPY } from '../lib/replica-tier-copy.js'
import { rememberReplicaKey } from '../lib/replica-unlock.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

claimIsolatedWhiteboardDb('replica-read-page')

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FB0'
const DOC_MD = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const DOC_SP = '01ARZ3NDEKTSV4RRFFQ69G5FB2'
const DOC_LINKER = '01ARZ3NDEKTSV4RRFFQ69G5FB3'
const DOC_EMBEDDER = '01ARZ3NDEKTSV4RRFFQ69G5FB4'
const SYNCED = '2026-09-01T12:00:00.000Z'
const DAEMON = 'http://127.0.0.1:3099'

const WORKSPACE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const WORKSPACE_SALT = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)

function b64u(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

/** A daemon fetch double answering /replica-key with a fixed offline key. */
function offlineKeyFetch(): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith('/replica-key')) {
      return jsonResponse({
        workspaceKey: b64u(WORKSPACE_KEY),
        workspaceKeySalt: b64u(WORKSPACE_SALT),
        tier: 'offline',
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

/** A daemon fetch double refusing /replica-key with a membership reason. */
function refusalKeyFetch(reason: string): typeof fetch {
  return (async () => jsonResponse({ error: reason, message: reason }, 403)) as typeof fetch
}

function noopReconnect(): Promise<void> {
  return Promise.resolve()
}

/**
 * The fixture routes every seed through the SEALED path (`connectReplicaKeeper`
 * + `markReplica`), not a bare `BrowserWorkspaceDocs().save` — a page that
 * reads a replica reads SEALED bytes in production, and a plaintext fixture
 * would pass the page's key-withheld branches over content that was never
 * actually withheld from anything.
 */
async function seedReplica(): Promise<void> {
  connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: offlineKeyFetch() })
  markReplica(DAEMON_WS, DAEMON)
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: 'notes/plan',
    documentId: DOC_MD,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(record, DOC_MD), '# Hello from the cache')
  createWorkspaceDocumentAtPath(record, { path: 'sketch', documentId: DOC_SP, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(record, DOC_SP), {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 120, height: 40, text: 'cached node' })],
    edges: [],
  })
  // Two documents that POINT at `notes/plan`: one a markdown body with a
  // wiki link, one a canvas whose text node embeds it. The replica record
  // holds every document, so both are resolvable entirely offline.
  createWorkspaceDocumentAtPath(record, {
    path: 'notes/linker',
    documentId: DOC_LINKER,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(record, DOC_LINKER), '# Linker\n\n[[notes/plan]]')
  createWorkspaceDocumentAtPath(record, {
    path: 'embedder',
    documentId: DOC_EMBEDDER,
    kind: 'spatial',
  })
  writeSpatialCanvas(documentContainers(record, DOC_EMBEDDER), {
    nodes: [
      textNode({ id: 'e1', x: 0, y: 0, width: 320, height: 220, text: 'See:\n\n![[notes/plan]]' }),
    ],
    edges: [],
  })
  record.commit()
  await new BrowserWorkspaceDocs().save(DAEMON_WS, record)
}

const PRF = new Uint8Array(32).fill(11)
const SEALED_KEYS = 'whiteboard:replica-sealed-keys'
const PASSKEYS = 'whiteboard:daemon-passkeys'
const RAW_ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])

/**
 * Leaves this device in the state a cold start finds: a sealed replica in
 * IndexedDB, a wrapped key beside it, a registered passkey, and NOTHING
 * held in memory — the holder forgotten and the daemon disconnected, which
 * is what closing the tab does.
 */
async function forgetEverythingButTheBlob(): Promise<void> {
  await rememberReplicaKey({
    daemonBaseUrl: DAEMON,
    workspaceId: DAEMON_WS,
    response: {
      workspaceKey: b64u(WORKSPACE_KEY),
      workspaceKeySalt: b64u(WORKSPACE_SALT),
      tier: 'offline',
    },
    prfOutput: PRF,
  })
  localStorage.setItem(
    PASSKEYS,
    JSON.stringify({
      [DAEMON]: { credentialId: b64u(RAW_ID), registeredAt: '2026-09-21T00:00:00.000Z' },
    }),
  )
  connectReplicaKeeper(null)
  forgetAll()
}

beforeEach(clearWhiteboardDb)
afterEach(() => {
  connectReplicaKeeper(null)
  forgetAll()
  localStorage.removeItem(SEALED_KEYS)
  localStorage.removeItem(PASSKEYS)
  cleanup()
})

describe('ReplicaReadPage', () => {
  it('lists the replica record and reads a markdown body from it', async () => {
    await seedReplica()
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        displayName="Design team"
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    await screen.findByTestId('replica-state-readable')
    const banner = await screen.findByTestId('replica-offline-banner')
    expect(banner.textContent).toMatch(/unreachable/i)
    // Decision 3's split, stated where the user reads: markdown edits are
    // taken (and ship later); spatial stays read-only.
    expect(banner.textContent).toMatch(/ship to the daemon/i)
    expect(banner.textContent).toContain('Design team')

    await userEvent.click(await screen.findByText('plan'))
    // Split view: the body appears in BOTH the source pane and the preview.
    expect(await screen.findAllByText(/Hello from the cache/)).toHaveLength(2)
  })

  it('the offline banner omits the synced clause when syncedAt is absent', async () => {
    await seedReplica()
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    const banner = await screen.findByTestId('replica-offline-banner')
    expect(banner.textContent).not.toMatch(/synced/i)
  })

  it('a spatial edit persists as a visible diff — the unknown record survives', async () => {
    // Decision 3's spatial half. The unknown-version record is the sharp
    // edge: a whole-canvas resync would delete it, and on a replica that
    // deletion SHIPS — so the page must persist through the visible-diff
    // reconcile, and the planted record must survive an edit session.
    await seedReplica()
    {
      const docs = new BrowserWorkspaceDocs()
      const record = await docs.open(DAEMON_WS)
      // Into the DOCUMENT's own containers — the workspace record scopes
      // each document's nodes map under its subtree, and a root-level map
      // of the same name is a different (unread) container.
      documentContainers(record!, DOC_SP)
        .getMap('nodes')
        .set('from-the-future', { type: 'hologram', shimmer: true })
      record!.commit()
      await docs.save(DAEMON_WS, record!)
    }
    const { unmount } = render(
      // A real pane height: the page fills its parent, and RTL's default
      // container has none — a zero-height editor is not the surface under
      // test.
      <div style={{ width: 900, height: 600 }}>
        <ReplicaReadPage
          workspaceId={DAEMON_WS}
          syncedAt={SYNCED}
          daemonBaseUrl={DAEMON}
          renewal="unreachable"
          onReconnect={noopReconnect}
        />
      </div>,
    )
    await userEvent.click(await screen.findByText('sketch'))
    const editor = await screen.findByTestId('spatial-editor')
    expect(await screen.findByText(/cached node/)).toBeTruthy()

    // Double-click empty space: creates a text node and opens its editor.
    // Coordinates from the editor's own box — the pane's size depends on
    // the test viewport, and a point outside it would pan, not create.
    const box = editor.getBoundingClientRect()
    const cx = box.left + box.width * 0.7
    const cy = box.top + box.height * 0.7
    for (const type of ['pointerdown', 'pointerup', 'pointerdown', 'pointerup']) {
      editor.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          clientX: cx,
          clientY: cy,
          pointerId: 7,
          button: 0,
        }),
      )
      await new Promise((r) => setTimeout(r, 30))
    }
    await screen.findByTestId('text-node-editor')
    fillNodeEditor(document, 'offline sketch note')
    ;(nodeEditorContent(document) as HTMLElement).blur()
    unmount()

    await vi.waitFor(async () => {
      const record = await new BrowserWorkspaceDocs().open(DAEMON_WS)
      const canvas = readSpatialCanvas(documentContainers(record!, DOC_SP))
      expect(canvas.nodes.map((n) => nodeText(n) ?? '')).toContain('offline sketch note')
      // The record today's schema cannot read is still there, untouched.
      expect(documentContainers(record!, DOC_SP).getMap('nodes').get('from-the-future')).toEqual({
        type: 'hologram',
        shimmer: true,
      })
    })
  })

  it('a missing replica renders needs-connection, and is NOT minted by the visit', async () => {
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    const region = await screen.findByTestId('replica-state-needs-connection')
    expect(region.textContent).toContain(REPLICA_TIER_COPY['no-offline'])
    // `open`, never `create`: the visit must not have materialized a record
    // under the daemon's id — an empty record there would read as the
    // daemon's data being gone.
    expect(await new BrowserWorkspaceDocs().open(DAEMON_WS)).toBeNull()
  })

  it('reading leaves the replica record byte-identical', async () => {
    await seedReplica()
    const before = (await new BrowserWorkspaceDocs().open(DAEMON_WS))!.oplogVersion().encode()
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    await userEvent.click(await screen.findByText('plan'))
    await screen.findAllByText(/Hello from the cache/)
    const after = (await new BrowserWorkspaceDocs().open(DAEMON_WS))!.oplogVersion().encode()
    expect(Array.from(after)).toEqual(Array.from(before))
  })

  it('resolves a wiki link from the replica record alone, with no daemon to ask', async () => {
    // The replica holds every document in the workspace, so a reference is
    // answerable offline — the alias table from its own entries, the body
    // from its own containers. Without seams the editor draws the literal
    // brackets, which is what the reader sees on the one page that exists
    // BECAUSE the keeper is unreachable.
    await seedReplica()
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    await userEvent.click(await screen.findByText('linker'))

    await vi.waitFor(() => {
      const anchor = document.querySelector(`a[href="${DOC_MD}"]`)
      if (anchor === null) throw new Error('the wiki link did not resolve to the document')
      return anchor
    })
  })

  it("draws an embedded note inside a canvas text node, from the replica's own copy", async () => {
    await seedReplica()
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    await userEvent.click(await screen.findByText('embedder'))

    await vi.waitFor(() => {
      const drawn = [...document.querySelectorAll('svg text')]
        .map((node) => node.textContent ?? '')
        .join(' ')
      expect(drawn).toContain('Hello from the cache')
    })
  })

  it('a markdown edit persists to the replica record, and files no index row', async () => {
    await seedReplica()
    const { unmount } = render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    await userEvent.click(await screen.findByText('plan'))

    await focusEditable(() => document.querySelector('[contenteditable="true"]'))
    await userEvent.keyboard('{Control>}{End}{/Control} offline addition')
    // Unmount flushes the debounce — the daemon returning swaps this page
    // out, and that moment must not eat the last keystrokes.
    unmount()

    await vi.waitFor(async () => {
      const record = await new BrowserWorkspaceDocs().open(DAEMON_WS)
      expect(readMarkdownBody(documentContainers(record!, DOC_MD))).toContain('offline addition')
    })
    // Decision 3's boundary: a data-plane edit files NOTHING in any index —
    // no phantom document rows under either workspace id.
    await expect(new IdbDocumentIndex().listDocuments({ workspaceId: DAEMON_WS })).rejects.toThrow()
  })
})

describe('ReplicaReadPage states', () => {
  it('locked (cold start): Reconnect transitions to readable without a remount', async () => {
    await seedReplica()
    // Cold start: nobody has asked S4a for this workspace's key yet in
    // THIS render — clearing it reproduces a fresh tab that never held it.
    connectReplicaKeeper(null)
    forgetAll()

    const onReconnect = vi.fn(async () => {
      connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: offlineKeyFetch() })
    })
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={onReconnect}
      />,
    )
    const locked = await screen.findByTestId('replica-state-locked')
    const reconnect = await screen.findByRole('button', { name: 'Reconnect' })
    expect(locked.textContent).toMatch(/locked/i)

    await userEvent.click(reconnect)
    expect(onReconnect).toHaveBeenCalledTimes(1)
    await screen.findByTestId('replica-state-readable')
    await userEvent.click(await screen.findByText('plan'))
    expect(await screen.findAllByText(/Hello from the cache/)).toHaveLength(2)
  })

  it('locked (lapsed lease): names the bounded-tier sentence, not an ordinary disconnection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const now = Date.now()
      const leaseExpiresAt = new Date(now + 60_000).toISOString()
      connectReplicaKeeper({
        baseUrl: DAEMON,
        token: 'tok',
        fetch: (async (input: Request | string | URL) => {
          const url = input instanceof Request ? input.url : String(input)
          if (url.endsWith('/replica-key')) {
            return jsonResponse({
              workspaceKey: b64u(WORKSPACE_KEY),
              workspaceKeySalt: b64u(WORKSPACE_SALT),
              tier: 'bounded',
              leaseExpiresAt,
            })
          }
          throw new Error(`unexpected fetch ${url}`)
        }) as typeof fetch,
      })
      markReplica(DAEMON_WS, DAEMON)
      const record = new LoroDoc()
      createWorkspaceDocumentAtPath(record, {
        path: 'notes/plan',
        documentId: DOC_MD,
        kind: 'markdown',
      })
      writeMarkdownBody(documentContainers(record, DOC_MD), '# Hello from the cache')
      record.commit()
      await new BrowserWorkspaceDocs().save(DAEMON_WS, record)

      // Past the lease. Deliberately still "connected" — `sessionKey`'s own
      // lapse check answers `withheld:'lapsed'` unconditionally on a cached
      // entry past its lease, without even consulting the source, so this
      // proves the lapse is detected on its own rather than because nobody
      // could be asked. `render` runs the load effect AFTER this, so the
      // page's own `open()` is what discovers the lapse.
      vi.setSystemTime(now + 120_000)

      render(
        <ReplicaReadPage
          workspaceId={DAEMON_WS}
          syncedAt={SYNCED}
          daemonBaseUrl={DAEMON}
          renewal="unreachable"
          onReconnect={noopReconnect}
        />,
      )
      const locked = await screen.findByTestId('replica-state-locked')
      expect(locked.textContent).toContain(REPLICA_TIER_COPY.bounded)
    } finally {
      vi.useRealTimers()
    }
  })

  it('unpaired (renewal refused): says the device is unpaired, never that the person was removed', async () => {
    await seedReplica()
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="refused"
        onReconnect={noopReconnect}
      />,
    )
    const unpaired = await screen.findByTestId('replica-state-unpaired')
    expect(unpaired.textContent).toContain('no longer paired')
    expect(unpaired.textContent).not.toContain('removed')
    expect(screen.queryByTestId('replica-state-removed')).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(document.querySelector('[contenteditable]')).toBeNull()
  })

  it('removed (key refusal not_a_member): no tree, no editor, no button', async () => {
    await seedReplica()
    connectReplicaKeeper(null)
    forgetAll()
    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: refusalKeyFetch('not_a_member') })

    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    const removed = await screen.findByTestId('replica-state-removed')
    expect(removed.textContent).toContain(
      'removed from this workspace; changes made since then were not sent',
    )
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(document.querySelector('[contenteditable]')).toBeNull()
  })

  it('withheld not_a_member renders removed with no replica record on this device, opening none', async () => {
    // No seedReplica(): the daemon already answered directly (a live-daemon
    // membership refusal), so the page must never open the record at all —
    // without the withheld prop bypassing that open, an ABSENT record here
    // would read as 'needs-connection' rather than 'removed'.
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        withheld="not_a_member"
        onReconnect={noopReconnect}
      />,
    )
    const removed = await screen.findByTestId('replica-state-removed')
    expect(removed.textContent).toContain(
      'removed from this workspace; changes made since then were not sent',
    )
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(await new BrowserWorkspaceDocs().open(DAEMON_WS)).toBeNull()
  })

  it('the reason reaches the page: unknown_credential is locked, not removed', async () => {
    await seedReplica()
    connectReplicaKeeper(null)
    forgetAll()
    connectReplicaKeeper({
      baseUrl: DAEMON,
      token: 'tok',
      fetch: refusalKeyFetch('unknown_credential'),
    })

    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    await screen.findByTestId('replica-state-locked')
  })

  it('needs-connection: Retry connection calls onReconnect', async () => {
    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: offlineKeyFetch() })
    markReplica(DAEMON_WS, DAEMON)
    const onReconnect = vi.fn(async () => {})

    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={onReconnect}
      />,
    )
    const region = await screen.findByTestId('replica-state-needs-connection')
    expect(region.textContent).toContain(REPLICA_TIER_COPY['no-offline'])
    await userEvent.click(await screen.findByRole('button', { name: 'Retry connection' }))
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('loading and reconnecting lines are status regions', async () => {
    await seedReplica()
    connectReplicaKeeper(null)
    forgetAll()
    let releaseReconnect: () => void = () => {}
    const onReconnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReconnect = resolve
        }),
    )
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={onReconnect}
      />,
    )
    await screen.findByTestId('replica-state-locked')
    // The ONE role="status" region is mounted for the page's whole life
    // (polite-live-region.test.ts): its text changes rather than the
    // element appearing already carrying a message.
    const status = await screen.findByTestId('replica-live-status')
    expect(status.getAttribute('role')).toBe('status')
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }))
    await screen.findByTestId('replica-locked-busy-line')
    expect(status.textContent).toBe('Reconnecting…')
    releaseReconnect()
    await vi.waitFor(() => {
      expect(screen.queryByTestId('replica-locked-busy-line')).toBeNull()
      // 'locked' is itself a page-critical connectivity message, not
      // silence: a screen-reader user who was mid-'Reconnecting…' must
      // still hear why the page settled back where it did.
      expect(status.textContent).toBe(REPLICA_STATE_COPY.locked.body)
    })
  })

  it('locked and needs-connection are announced in the live region, not left silent', async () => {
    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: offlineKeyFetch() })
    markReplica(DAEMON_WS, DAEMON)
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    await screen.findByTestId('replica-state-needs-connection')
    expect((await screen.findByTestId('replica-live-status')).textContent).toBe(
      REPLICA_STATE_COPY['needs-connection'].body,
    )
  })
})

describe('ReplicaReadPage: the cold start (ADR-0042 d6)', () => {
  it('offers an unlock instead of a reconnect, and reads the cached body once the passkey answers', async () => {
    await seedReplica()
    await forgetEverythingButTheBlob()
    // `navigator.credentials` in a real browser: the page performs the
    // gesture through the platform, so the double goes there rather than
    // into a prop only a test would pass.
    const get = vi.spyOn(navigator.credentials, 'get').mockResolvedValue({
      rawId: RAW_ID.buffer,
      response: {
        authenticatorData: new Uint8Array(37).fill(1).buffer,
        clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer,
        signature: new Uint8Array([7, 7, 7]).buffer,
      },
      getClientExtensionResults: () => ({ prf: { results: { first: PRF.buffer } } }),
    } as unknown as Credential)

    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )

    const unlockable = await screen.findByTestId('replica-state-unlockable')
    // The offer says what it costs: the passkey is the recovery path.
    expect(unlockable.textContent).toMatch(/lose that passkey/i)
    // Not the reconnect offer — an unreachable daemon is beside the point
    // for a copy this device can open by itself.
    expect(screen.queryByTestId('replica-state-locked')).toBeNull()

    await userEvent.click(
      await screen.findByRole('button', { name: REPLICA_STATE_COPY.unlockable.action }),
    )

    await screen.findByTestId('replica-state-readable')
    expect(get).toHaveBeenCalledTimes(1)
    await userEvent.click(await screen.findByText('plan'))
    expect(await screen.findAllByText(/Hello from the cache/)).toHaveLength(2)

    get.mockRestore()
  })

  it('stops offering an unlock once the blob turns out to be unopenable', async () => {
    await seedReplica()
    await forgetEverythingButTheBlob()
    // A different authenticator: the derived key is not the one that
    // wrapped the blob, so nothing on this device can open it.
    const get = vi.spyOn(navigator.credentials, 'get').mockResolvedValue({
      rawId: RAW_ID.buffer,
      response: {
        authenticatorData: new Uint8Array(37).fill(1).buffer,
        clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer,
        signature: new Uint8Array([7, 7, 7]).buffer,
      },
      getClientExtensionResults: () => ({
        prf: { results: { first: new Uint8Array(32).fill(99).buffer } },
      }),
    } as unknown as Credential)

    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        syncedAt={SYNCED}
        daemonBaseUrl={DAEMON}
        renewal="unreachable"
        onReconnect={noopReconnect}
      />,
    )
    await userEvent.click(
      await screen.findByRole('button', { name: REPLICA_STATE_COPY.unlockable.action }),
    )

    // The offer is withdrawn rather than repeated: an unlock that cannot
    // succeed must not keep asking someone to prove themselves.
    await screen.findByTestId('replica-state-locked')
    expect(localStorage.getItem(SEALED_KEYS)).not.toContain(DAEMON_WS)

    get.mockRestore()
  })
})
