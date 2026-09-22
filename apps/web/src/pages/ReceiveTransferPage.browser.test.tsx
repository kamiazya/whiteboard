/**
 * The receiving page end to end, in a real browser: a stub opener announces
 * nothing and posts an offer as a real `MessageEvent`, the person accepts, and
 * the merge is verified by reading the DESTINATION's record back — never by
 * trusting that the POST happened.
 *
 * The keeper is stubbed at the fetch seam the way the promote tests stub it:
 * its promote route imports the posted bytes into a real `LoroDoc`, which is
 * the verification, and its document list answers from that same doc.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readWorkspaceDocuments,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { CROSS_ORIGIN_TRANSFER_PROTOCOL } from '../lib/cross-origin-transfer-protocol.js'
import type { PasskeyCredentials } from '../lib/passkey-attestation.js'
import { ReceiveTransferPage } from './ReceiveTransferPage.js'

const SENDER = 'https://app.example'
const NONCE = 'n'.repeat(32)
const PASSKEYS_KEY = 'whiteboard:daemon-passkeys'
const RAW_ID = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
const MARKDOWN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const SPATIAL_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
const IMAGE_ID = 'arrived-image-1'

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** The record a sender would post: one note, one board showing an image. */
function senderSnapshot(): Uint8Array {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: 'notes/roadmap',
    documentId: MARKDOWN_ID,
    kind: 'markdown',
  })
  createWorkspaceDocumentAtPath(record, { path: 'board', documentId: SPATIAL_ID, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(record, SPATIAL_ID), {
    nodes: [
      fileNode({ id: 'img', file: newImageRef(IMAGE_ID), x: 0, y: 0, width: 10, height: 10 }),
    ],
    edges: [],
  })
  record.commit()
  return new Uint8Array(record.export({ mode: 'snapshot' }))
}

function keeperStub(target: LoroDoc, promotes: unknown[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    // A keeper refuses what carries no credential — so a request that skipped
    // the auth seam fails here the way it would against a real one.
    if (new Headers(init?.headers).get('Authorization') !== 'Bearer t') {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    }
    if (url.endsWith('/api/workspaces')) {
      return Response.json({ workspaces: [{ workspaceId: 'ws-here', displayName: 'Here' }] })
    }
    if (url.endsWith('/workspace-document/promote') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { snapshot: string; attestation?: unknown }
      promotes.push(body)
      target.import(base64UrlToBytes(body.snapshot))
      return Response.json({
        ok: true,
        attested: body.attestation !== undefined,
        recorded: readWorkspaceDocuments(target).map((entry) => entry.documentId),
        shadowed: [],
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
}

function fakePasskey(): PasskeyCredentials {
  return {
    create: async () => null,
    get: async () =>
      ({
        id: b64u(RAW_ID),
        type: 'public-key',
        rawId: RAW_ID.buffer,
        response: {
          authenticatorData: new Uint8Array(37).buffer,
          clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer,
          signature: Uint8Array.from([1, 2, 3]).buffer,
        },
      }) as unknown as Credential,
  }
}

/** A message exactly as the browser delivers one: `origin` is its word, not the body's. */
function arrive(origin: string, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { origin, data }))
}

const offer = (over: Record<string, unknown> = {}) => ({
  type: 'transfer-offer',
  protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
  nonce: NONCE,
  snapshot: senderSnapshot(),
  documentCount: 2,
  sourceWorkspaceId: 'ws-sender',
  ...over,
})

const returnTo = window.location.pathname + window.location.search

beforeEach(() => {
  history.replaceState(
    null,
    '',
    `/receive-transfer#${new URLSearchParams({ from: SENDER, nonce: NONCE })}`,
  )
  localStorage.setItem(
    PASSKEYS_KEY,
    JSON.stringify({ [window.location.origin]: { credentialId: b64u(RAW_ID), registeredAt: 'x' } }),
  )
})
afterEach(() => {
  cleanup()
  localStorage.removeItem(PASSKEYS_KEY)
  history.replaceState(null, '', returnTo)
})

describe('ReceiveTransferPage', () => {
  it('announces itself to the opener, at the sender origin and never to "*"', async () => {
    const opener = { postMessage: vi.fn() }
    render(
      <ReceiveTransferPage
        daemonToken="t"
        fetchFn={keeperStub(new LoroDoc(), [])}
        opener={opener}
      />,
    )
    await waitFor(() => expect(opener.postMessage).toHaveBeenCalled())
    expect(opener.postMessage.mock.calls[0]).toEqual([
      { type: 'transfer-ready', protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL, nonce: NONCE },
      SENDER,
    ])
  })

  it('merges an accepted offer, verified by reading the destination back', async () => {
    const target = new LoroDoc()
    const promotes: unknown[] = []
    const opener = { postMessage: vi.fn() }
    render(
      <ReceiveTransferPage
        daemonToken="t"
        fetchFn={keeperStub(target, promotes)}
        opener={opener}
        passkeyCredentials={fakePasskey()}
      />,
    )
    arrive(SENDER, offer())
    expect((await screen.findByTestId('receive-transfer-offer')).textContent).toMatch(
      /says it is sending 2 documents/,
    )
    await userEvent.click(screen.getByTestId('receive-transfer-accept'))

    const done = await screen.findByTestId('receive-transfer-done')
    // The destination's OWN record, not the response, is what says it landed.
    expect(
      readWorkspaceDocuments(target)
        .map((e) => e.documentId)
        .sort(),
    ).toEqual([MARKDOWN_ID, SPATIAL_ID])
    expect(done.textContent).toMatch(/Received 2 documents/)
    // The image did not travel, and the page says so rather than implying it.
    expect(done.textContent).toMatch(/1 image could not be carried/)

    const reply = opener.postMessage.mock.calls.at(-1)
    if (reply === undefined) throw new Error('expected a reply to the opener')
    expect(reply[1]).toBe(SENDER)
    expect(reply[0]).toMatchObject({
      type: 'transfer-result',
      nonce: NONCE,
      ok: true,
      workspaceId: 'ws-here',
    })
    expect((reply[0] as { imagesMissing: string[] }).imagesMissing).toHaveLength(1)
    // The passkey asked here signed it, and the keeper recorded that.
    expect(promotes).toHaveLength(1)
    expect((reply[0] as { attested: boolean }).attested).toBe(true)
  })

  it('shows nothing for an offer from another origin, however well-formed', async () => {
    const promotes: unknown[] = []
    render(
      <ReceiveTransferPage
        daemonToken="t"
        fetchFn={keeperStub(new LoroDoc(), promotes)}
        opener={null}
      />,
    )
    // `act` flushes whatever state the listener set, so the assertion below
    // reads the settled page rather than racing a render — a condition, not
    // a wait for time.
    await act(async () => arrive('https://attacker.example', offer()))
    expect(screen.queryByTestId('receive-transfer-offer')).toBeNull()
    expect(screen.queryByTestId('receive-transfer-refused')).toBeNull()
    expect(screen.getByTestId('receive-transfer-status').textContent).toMatch(/Waiting/)
  })

  it('refuses an offer from another attempt, and merges nothing', async () => {
    const target = new LoroDoc()
    render(<ReceiveTransferPage daemonToken="t" fetchFn={keeperStub(target, [])} opener={null} />)
    arrive(SENDER, offer({ nonce: 'x'.repeat(32) }))
    expect((await screen.findByTestId('receive-transfer-refused')).textContent).toMatch(
      /different transfer attempt/,
    )
    expect(readWorkspaceDocuments(target)).toEqual([])
  })

  it('without a passkey registered here, refuses the merge and tells the sender', async () => {
    localStorage.removeItem(PASSKEYS_KEY)
    const target = new LoroDoc()
    const promotes: unknown[] = []
    const opener = { postMessage: vi.fn() }
    render(
      <ReceiveTransferPage
        daemonToken="t"
        fetchFn={keeperStub(target, promotes)}
        opener={opener}
        passkeyCredentials={fakePasskey()}
      />,
    )
    arrive(SENDER, offer())
    await userEvent.click(await screen.findByTestId('receive-transfer-accept'))
    expect((await screen.findByTestId('receive-transfer-refused')).textContent).toMatch(
      /Register a passkey for this keeper first/,
    )
    // Refused BEFORE the POST: the keeper never saw the bytes.
    expect(promotes).toEqual([])
    expect(readWorkspaceDocuments(target)).toEqual([])
    expect(opener.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ ok: false, nonce: NONCE })
  })

  it('says there is nothing to receive when opened without a transfer fragment', () => {
    history.replaceState(null, '', '/receive-transfer')
    render(
      <ReceiveTransferPage daemonToken="t" fetchFn={keeperStub(new LoroDoc(), [])} opener={null} />,
    )
    expect(screen.getByText('Nothing to receive')).not.toBeNull()
  })
})
