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

import { forget, forgetAll } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  readWorkspaceDocuments,
  resolveWorkspaceDocumentById,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserWorkspaceDocs } from '../../lib/browser-workspace-docs.js'
import { getBrowserWorkspaceId } from '../../lib/browser-workspace-id.js'
import { DocumentFileStore } from '../../lib/document-file-store.js'
import { FoldingBrowserIndex } from '../../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../../lib/idb-document-index.js'
import { ensureLocalWorkspace } from '../../lib/local-document-summary.js'
import { LoroStore } from '../../lib/loro-store.js'
import type { PasskeyCredentials } from '../../lib/passkey-attestation.js'
import { connectReplicaKeeper } from '../../lib/replica-store.js'
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
  /** Every promote body the daemon received — what travelled, not what was meant to. */
  promotes?: Array<{ snapshot: string; attestation?: { credentialId: string } }>
  /** Every credential registration the daemon received. */
  registrations?: Array<{ credentialId: string; publicKey: string; authenticatorData: string }>
  /** Refuse blob PUTs, so the demote gate has a real failed transfer. */
  failPutStatus?: number
  /** Serve THESE bytes from the snapshot route instead of the merged target. */
  snapshotBytes?: () => Uint8Array
  workspaces?: { workspaceId: string; segment?: string; displayName?: string }[]
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const RAW_ID = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
const PASSKEYS_KEY = 'whiteboard:daemon-passkeys'

/** A platform authenticator as the flow sees it: one registration, and assertions that sign whatever they are asked. */
function fakePasskey(): PasskeyCredentials & { asked: CredentialRequestOptions[] } {
  const asked: CredentialRequestOptions[] = []
  return {
    asked,
    create: async () =>
      ({
        id: b64u(RAW_ID),
        type: 'public-key',
        rawId: RAW_ID.buffer,
        response: {
          getPublicKey: () => Uint8Array.from([48, 89, 48, 19]).buffer,
          getAuthenticatorData: () => new Uint8Array(37).buffer,
        },
      }) as unknown as Credential,
    get: async (options) => {
      asked.push(options)
      return {
        id: b64u(RAW_ID),
        type: 'public-key',
        rawId: RAW_ID.buffer,
        response: {
          authenticatorData: new Uint8Array(37).buffer,
          clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer,
          signature: Uint8Array.from([1, 2, 3]).buffer,
        },
      } as unknown as Credential
    },
  }
}

/**
 * The daemon routes the flow touches, answering from `target` — and, as a
 * side effect of building it, connects the S4b replica-key holder to THIS
 * double. The demote pull inside `promoteWorkspace` (via `cacheDaemonWorkspace`)
 * now seals its write, which needs a connected keeper and a `/replica-key`
 * answer to do at all; every caller here already builds a fresh double
 * before triggering the flow, so this is the one place to wire it from.
 */
function daemonStub(target: LoroDoc, opts: StubOptions = {}): typeof globalThis.fetch {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/replica-key') && init?.method === 'POST') {
      return Response.json({
        workspaceKey: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
        workspaceKeySalt: 'oKGio6SlpqeoqaqrrK2urw',
        tier: 'offline',
      })
    }
    if (url.endsWith('/api/workspaces') && (init?.method ?? 'GET') === 'GET') {
      return Response.json({
        workspaces: opts.workspaces ?? [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      })
    }
    if (url.endsWith('/workspace-document/promote') && init?.method === 'POST') {
      if (opts.updateDelayMs) await new Promise((r) => setTimeout(r, opts.updateDelayMs))
      if (opts.updateGate) await opts.updateGate
      if (opts.failUpdateStatus) {
        return Response.json(
          { title: `Workspace "ws-a" not found` },
          { status: opts.failUpdateStatus },
        )
      }
      const body = JSON.parse(init.body as string) as {
        snapshot: string
        attestation?: { credentialId: string }
      }
      opts.promotes?.push(body)
      target.import(base64UrlToBytes(body.snapshot))
      return Response.json({
        ok: true,
        attested: body.attestation !== undefined,
        recorded: readWorkspaceDocuments(target).map((entry) => entry.documentId),
        shadowed: [],
      })
    }
    if (url.endsWith('/api/pairing/credentials') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as {
        credentialId: string
        publicKey: string
        authenticatorData: string
      }
      opts.registrations?.push(body)
      return Response.json(
        {
          credentialId: body.credentialId,
          origin: location.origin,
          backupEligible: true,
          createdAt: '2026-09-16T00:00:00.000Z',
        },
        { status: 201 },
      )
    }
    if (url.includes('/file/') && init?.method === 'PUT') {
      if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs))
      if (opts.failPutStatus) return new Response(null, { status: opts.failPutStatus })
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/workspace-document/snapshot') && (init?.method ?? 'GET') === 'GET') {
      // The demote pull: the merged target's own bytes, as the real route serves.
      const bytes = opts.snapshotBytes?.() ?? target.export({ mode: 'snapshot' })
      return new Response(bytes as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
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
  connectReplicaKeeper({ baseUrl: BASE, token: DAEMON.token, fetch: fetchImpl })
  return fetchImpl
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
    nodes: [fileNode({ id: 'img', file: newImageRef('img-1'), x: 0, y: 0, width: 5, height: 5 })],
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
    .set('n1', textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text: 'pre-fold' }))
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
  localStorage.removeItem(PASSKEYS_KEY)
  await clearWhiteboardDb()
})
afterEach(() => {
  cleanup()
  connectReplicaKeeper(null)
  forgetAll()
  vi.restoreAllMocks()
})

describe('PromoteWorkspaceSection', () => {
  it('with a passkey registered here, the move is confirmed with it, the assertion travels, and the result says so', async () => {
    await seedTwoDocuments()
    localStorage.setItem(
      PASSKEYS_KEY,
      JSON.stringify({ [BASE]: { credentialId: b64u(RAW_ID), registeredAt: 'x' } }),
    )
    const passkey = fakePasskey()
    const promotes: StubOptions['promotes'] = []
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), { promotes })}
        passkeyCredentials={passkey}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    expect((await screen.findByTestId('promote-passkey')).textContent).toMatch(
      /you will be asked to confirm the move with it/i,
    )
    await userEvent.click(screen.getByTestId('promote-confirm'))
    const result = await screen.findByTestId('promote-last-result')
    expect(result.textContent).toMatch(/your passkey confirmed this move/i)
    // One assertion, for the credential registered here, with user verification.
    expect(passkey.asked).toHaveLength(1)
    expect(passkey.asked[0]?.publicKey?.userVerification).toBe('required')
    expect(promotes).toHaveLength(1)
    expect(promotes[0]?.attestation?.credentialId).toBe(b64u(RAW_ID))
  })

  it('without a passkey the dialog offers to register one; registering pins it on the daemon and the move then asks for it', async () => {
    await seedTwoDocuments()
    const passkey = fakePasskey()
    const promotes: StubOptions['promotes'] = []
    const registrations: StubOptions['registrations'] = []
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), { promotes, registrations })}
        passkeyCredentials={passkey}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    expect((await screen.findByTestId('promote-passkey')).textContent).toMatch(
      /no passkey for this daemon yet/i,
    )
    await userEvent.click(screen.getByTestId('promote-register-passkey'))
    await waitFor(() =>
      expect(screen.getByTestId('promote-passkey').textContent).toMatch(/is registered/i),
    )
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.credentialId).toBe(b64u(RAW_ID))
    await userEvent.click(screen.getByTestId('promote-confirm'))
    expect((await screen.findByTestId('promote-last-result')).textContent).toMatch(
      /your passkey confirmed this move/i,
    )
    expect(promotes[0]?.attestation?.credentialId).toBe(b64u(RAW_ID))
  })

  it('while a passkey is being registered the move waits, so it cannot slip through unattested', async () => {
    await seedTwoDocuments()
    const passkey = fakePasskey()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const create = passkey.create
    passkey.create = async (options) => {
      await gate
      return create(options)
    }
    const promotes: StubOptions['promotes'] = []
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), { promotes, registrations: [] })}
        passkeyCredentials={passkey}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await userEvent.click(await screen.findByTestId('promote-register-passkey'))
    await waitFor(() =>
      expect(screen.getByTestId('promote-passkey-status').textContent).toMatch(/waiting/i),
    )
    const confirm = screen.getByTestId('promote-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    // A click that lands anyway (a stale handle, a programmatic call) moves nothing.
    confirm.click()
    expect(promotes).toHaveLength(0)
    release()
    await waitFor(() =>
      expect(screen.getByTestId('promote-passkey').textContent).toMatch(/is registered/i),
    )
    expect((screen.getByTestId('promote-confirm') as HTMLButtonElement).disabled).toBe(false)
    await userEvent.click(screen.getByTestId('promote-confirm'))
    expect((await screen.findByTestId('promote-last-result')).textContent).toMatch(
      /your passkey confirmed this move/i,
    )
    expect(promotes).toHaveLength(1)
    expect(promotes[0]?.attestation?.credentialId).toBe(b64u(RAW_ID))
  })

  it('a browser without passkeys is told so, and the move is recorded without one', async () => {
    await seedTwoDocuments()
    const promotes: StubOptions['promotes'] = []
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), { promotes })}
        passkeyCredentials={null}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    expect((await screen.findByTestId('promote-passkey')).textContent).toMatch(
      /cannot use passkeys/i,
    )
    expect(screen.queryByTestId('promote-register-passkey')).toBeNull()
    await userEvent.click(screen.getByTestId('promote-confirm'))
    expect((await screen.findByTestId('promote-last-result')).textContent).toMatch(
      /recorded without a passkey/i,
    )
    expect(promotes[0]?.attestation).toBeUndefined()
  })

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
    // Record every text the live region shows, in order, from before the
    // transfer starts. Reading it once after `findBy` resolved raced the
    // first phase: under CI load the 150ms document phase was already over
    // and the region read "Moving referenced images…" — a real sequence
    // reported as a missing step. The observer sees each phase as it lands.
    const seen: string[] = []
    const observer = new MutationObserver(() => {
      const text = screen.queryByTestId('promote-progress')?.textContent ?? ''
      if (text !== '' && seen[seen.length - 1] !== text) seen.push(text)
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
    try {
      await userEvent.click(await screen.findByTestId('promote-confirm'))

      const progress = await screen.findByTestId('promote-progress')
      expect(progress.getAttribute('role')).toBe('status')
      expect(progress.getAttribute('aria-live')).toBe('polite')
      // The text advances with the transfer's real phases, before the flow ends.
      await waitFor(() => expect(seen.some((t) => /referenced images/i.test(t))).toBe(true))
      const documentsAt = seen.findIndex((t) => /moving documents and their history/i.test(t))
      const imagesAt = seen.findIndex((t) => /referenced images/i.test(t))
      expect(documentsAt, `phases seen: ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(0)
      expect(imagesAt).toBeGreaterThan(documentsAt)
      await screen.findByTestId('promote-last-result')
    } finally {
      observer.disconnect()
    }
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

    // Identity invariant: the same ids resolve on the daemon target, and in
    // the REPLICA this browser now holds under the daemon's id — the old
    // independent copy is gone (the verified demote deleted it).
    expect(resolveWorkspaceDocumentById(target, roadmapId)).not.toBeNull()
    expect(resolveWorkspaceDocumentById(target, sketchId)).not.toBeNull()
    const replica = await new BrowserWorkspaceDocs().open('ws-a')
    expect(replica).not.toBeNull()
    expect(
      readWorkspaceDocuments(replica!)
        .map((entry) => entry.documentId)
        .sort(),
    ).toEqual([roadmapId, sketchId].sort())

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

  it('a successful move leaves a cached copy of the daemon workspace in this browser', async () => {
    // ADR-0023 decision 2's first half: demote begins with the daemon's own
    // record cached back into this browser's planes, keyed by the DAEMON
    // workspace id, with the sync moment on the standing report.
    await seedTwoDocuments()
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
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    const result = await screen.findByTestId('promote-last-result')
    expect(result.textContent).toMatch(/cached in this browser/i)

    const replica = await new BrowserWorkspaceDocs().open('ws-a')
    expect(replica).not.toBeNull()
    expect(readWorkspaceDocuments(replica!)).toHaveLength(2)
    const promotion = createUserSettingsStore().load().migration.promotion
    if (promotion?.ok !== true) throw new Error('expected an ok promotion record')
    expect(promotion.replicaSyncedAt).toBeTruthy()
  })

  it('a successful move registers the replica so offline lookup finds it immediately', async () => {
    // The registry entry is what findReplicaForHandle and the AppShell
    // notice read; without it the cached bytes are invisible until some
    // later visit happens to refresh them.
    await seedTwoDocuments()
    const target = new LoroDoc()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(target, {
          workspaces: [{ workspaceId: 'ws-a', segment: 'team', displayName: 'Team docs' }],
        })}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    await screen.findByTestId('promote-last-result')

    const replica = createUserSettingsStore().load().storage.replicas?.['ws-a']
    expect(replica).toBeTruthy()
    expect(replica?.daemonBaseUrl).toBe(BASE)
    expect(replica?.syncedAt).toBeTruthy()
    expect(replica?.segment).toBe('team')
    expect(replica?.displayName).toBe('Team docs')
  })

  it('a verified move removes the browser copy and leaves a fresh empty workspace', async () => {
    // ADR-0023 decision 2's second half: once the replica verifiably holds
    // every promoted document, the old browser record stops existing —
    // deletion, not a frozen fork. A fresh empty workspace row keeps the
    // browser keeper bootable.
    await seedTwoDocuments()
    const sourceId = getBrowserWorkspaceId()
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
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    const result = await screen.findByTestId('promote-last-result')
    expect(result.textContent).toMatch(/browser copy was removed/i)

    // The old record is gone; the replica (daemon id) still opens.
    expect(await new BrowserWorkspaceDocs().open(sourceId)).toBeNull()
    expect(await new BrowserWorkspaceDocs().open('ws-a')).not.toBeNull()
    // The browser keeper stays bootable: the active identity was re-pointed
    // at a fresh empty workspace in the same operation.
    expect(getBrowserWorkspaceId()).not.toBe(sourceId)
    expect(
      await new FoldingBrowserIndex().listDocuments({ workspaceId: getBrowserWorkspaceId() }),
    ).toEqual([])
    const promotion = createUserSettingsStore().load().migration.promotion
    if (promotion?.ok !== true) throw new Error('expected an ok promotion record')
    expect(promotion.localCopyRemoved).toBe(true)
  })

  it('a missing blob keeps the browser copy — missing may be a fold-in of a read error', async () => {
    // DocumentFileStore.get never throws: an unreachable store degrades to
    // "missing", so a missing reference may be retryable — and the source
    // record is the retry vehicle a re-run of the move needs.
    const { sketchId } = await seedTwoDocuments()
    // An image REFERENCE whose bytes were never stored.
    const content = new LoroDoc()
    writeSpatialCanvas(content, {
      nodes: [
        fileNode({
          id: 'img',
          file: newImageRef('img-never-stored'),
          x: 0,
          y: 0,
          width: 5,
          height: 5,
        }),
      ],
      edges: [],
    })
    expect(
      await seedWorkspaceDocumentContent(
        sketchId,
        new Uint8Array(content.export({ mode: 'snapshot' })),
      ),
    ).toBe(true)
    const sourceId = getBrowserWorkspaceId()
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
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    const result = await screen.findByTestId('promote-last-result')
    expect(result.textContent).toMatch(/kept in this browser/i)

    expect(await new BrowserWorkspaceDocs().open(sourceId)).not.toBeNull()
    const promotion = createUserSettingsStore().load().migration.promotion
    if (promotion?.ok !== true) throw new Error('expected an ok promotion record')
    expect(promotion.blobsMissing).toHaveLength(1)
    expect(promotion.localCopyRemoved).toBe(false)
  })

  it('a failed blob transfer keeps the browser copy and says why', async () => {
    // The demote gate: deletion is allowed only when everything the record
    // references made it across. A refused image PUT means the daemon copy
    // is incomplete, so the browser record stays authoritative.
    const { sketchId } = await seedTwoDocuments()
    await seedImageOnSketch(sketchId)
    const sourceId = getBrowserWorkspaceId()
    const target = new LoroDoc()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(target, { failPutStatus: 507 })}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    const result = await screen.findByTestId('promote-last-result')
    expect(result.textContent).toMatch(/kept in this browser/i)

    expect(await new BrowserWorkspaceDocs().open(sourceId)).not.toBeNull()
    const promotion = createUserSettingsStore().load().migration.promotion
    if (promotion?.ok !== true) throw new Error('expected an ok promotion record')
    expect(promotion.localCopyRemoved).toBe(false)
  })

  it('an incomplete replica keeps the browser copy — deletion trusts only what was read back', async () => {
    // The snapshot route answers with an EMPTY record: the pull "succeeds",
    // but the replica verifiably does not hold the promoted documents, so
    // the source record must survive.
    await seedTwoDocuments()
    const sourceId = getBrowserWorkspaceId()
    const target = new LoroDoc()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(target, {
          snapshotBytes: () => new LoroDoc().export({ mode: 'snapshot' }),
        })}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    const result = await screen.findByTestId('promote-last-result')
    expect(result.textContent).toMatch(/kept in this browser/i)

    expect(await new BrowserWorkspaceDocs().open(sourceId)).not.toBeNull()
    const promotion = createUserSettingsStore().load().migration.promotion
    if (promotion?.ok !== true) throw new Error('expected an ok promotion record')
    expect(promotion.localCopyRemoved).toBe(false)
  })

  it('a successful move is reported ok even when the session key is withheld exactly at the demote read-back', async () => {
    // The move and the demote-cache write both already landed by the time
    // `replicaCarriesAll`'s read-back runs. Simulating the session lapsing
    // in that exact gap (ADR-0042: "a membership revocation is felt at the
    // next ask") must not turn the already-successful outcome into a
    // reported failure — it defers the demote decision instead.
    await seedTwoDocuments()
    const sourceId = getBrowserWorkspaceId()
    const target = new LoroDoc()
    const baseFetch = daemonStub(target)
    let keyRefused = false
    const interceptingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (keyRefused && url.endsWith('/replica-key') && init?.method === 'POST') {
        return Response.json({ error: 'not_a_member' }, { status: 403 })
      }
      return baseFetch(input, init)
    }) as typeof globalThis.fetch
    // Re-wires the session-key fetch to the intercepting one without
    // changing baseUrl/token, so this is not a reconnect (no key forgotten
    // as a side effect of the swap itself).
    connectReplicaKeeper({ baseUrl: BASE, token: DAEMON.token, fetch: interceptingFetch })
    // After the demote-cache write for the promoted workspace lands, drop
    // the held key and start refusing — the next ask (replicaCarriesAll's
    // read-back) must re-mint and finds the session gone.
    const originalSave = DocumentStoreWorkspaceDocs.prototype.save
    vi.spyOn(DocumentStoreWorkspaceDocs.prototype, 'save').mockImplementation(async function (
      this: DocumentStoreWorkspaceDocs,
      workspaceId: string,
      doc,
    ) {
      const result = await originalSave.call(this, workspaceId, doc)
      if (workspaceId === 'ws-a') {
        forget(BASE, workspaceId)
        keyRefused = true
      }
      return result
    })

    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={interceptingFetch}
        reload={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    await userEvent.click(await screen.findByTestId('promote-confirm'))
    const result = await screen.findByTestId('promote-last-result')
    expect(result.textContent).toMatch(/moved 2 documents/i)
    expect(result.textContent).not.toMatch(/failed/i)

    const promotion = createUserSettingsStore().load().migration.promotion
    if (promotion?.ok !== true) throw new Error('expected an ok promotion record')
    expect(promotion.localCopyRemoved).toBe(false)
    // The source browser copy survives — the demote decision was deferred,
    // not silently taken as "carries nothing".
    expect(await new BrowserWorkspaceDocs().open(sourceId)).not.toBeNull()
  })

  it('stays discoverable but disabled with no daemon connected', async () => {
    render(<PromoteWorkspaceSection settingsStore={createUserSettingsStore()} />)
    const trigger = screen.getByTestId('promote-workspace-open')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    expect(document.body.textContent).toMatch(/connect a daemon/i)
  })

  // The three 'unavailable' branches are the promote flow's only error
  // disclosure before a dialog exists — a regression here leaves the trigger
  // appearing to silently do nothing, the worst failure mode for a
  // data-migration action.
  it('an empty browser says there is nothing to move instead of opening the dialog', async () => {
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc())}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    const notice = await screen.findByTestId('promote-unavailable')
    expect(notice.textContent).toMatch(/no documents to move/i)
    expect(screen.queryByTestId('promote-dialog')).toBeNull()
  })

  it('a daemon with no workspace says to open one there first', async () => {
    await seedTwoDocuments()
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={daemonStub(new LoroDoc(), { workspaces: [] })}
      />,
    )
    await userEvent.click(screen.getByTestId('promote-workspace-open'))
    const notice = await screen.findByTestId('promote-unavailable')
    expect(notice.textContent).toMatch(/no workspace to move into yet/i)
    expect(notice.textContent).toMatch(/open one on the daemon first/i)
  })

  it('an unreachable daemon is disclosed and the trigger stays clickable for a retry', async () => {
    await seedTwoDocuments()
    const unreachable = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof globalThis.fetch
    render(
      <PromoteWorkspaceSection
        daemon={DAEMON}
        settingsStore={createUserSettingsStore()}
        baseFetch={unreachable}
      />,
    )
    const trigger = screen.getByTestId('promote-workspace-open')
    await userEvent.click(trigger)
    const notice = await screen.findByTestId('promote-unavailable')
    expect(notice.textContent).toMatch(/could not reach the daemon/i)
    // Recoverable, not a dead end: the same trigger retries, and a daemon
    // that answers this time opens the confirmation.
    expect(trigger.hasAttribute('disabled')).toBe(false)
  })
})
