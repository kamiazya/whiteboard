/**
 * Both halves of the cross-origin transfer against each other, in a real
 * browser: this section sends, the real `ReceiveTransferPage` receives, and
 * the destination's record is read back to prove the move landed.
 *
 * One window stands in for two by giving each side a DIFFERENT origin on the
 * messages it sends: the receiver's replies arrive as `https://keeper.example`
 * and the sender's offer as this page's own origin. Each side ignores what is
 * not from the origin it expects, so the two listeners on one window never
 * read each other's traffic — which is also a live check of that filtering.
 *
 * The receiver is rendered a microtask AFTER the window "opens", the way a
 * real popup loads asynchronously. Rendering it synchronously would let its
 * ready message fire before the sender is listening — a race a real browser
 * cannot produce, and one the handshake is not meant to survive.
 */
import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { getBrowserWorkspaceId } from '../../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../../lib/folding-browser-index.js'
import { ensureLocalWorkspace } from '../../lib/local-document-summary.js'
import type { PasskeyCredentials } from '../../lib/passkey-attestation.js'
import type { PopupHandle } from '../../lib/send-transfer.js'
import { ReceiveTransferPage } from '../../pages/ReceiveTransferPage.js'
import { clearWhiteboardDb } from '../../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../../test-utils/isolated-whiteboard-db.js'
import { TransferToKeeperSection } from './TransferToKeeperSection.js'

claimIsolatedWhiteboardDb('transfer-to-keeper')

const KEEPER = 'https://keeper.example'
const PASSKEYS_KEY = 'whiteboard:daemon-passkeys'
const RAW_ID = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
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

function keeperStub(target: LoroDoc): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/workspaces')) {
      return Response.json({ workspaces: [{ workspaceId: 'ws-there', displayName: 'There' }] })
    }
    if (url.endsWith('/workspace-document/promote') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { snapshot: string; attestation?: unknown }
      target.import(base64UrlToBytes(body.snapshot))
      return Response.json({
        ok: true,
        attested: body.attestation !== undefined,
        recorded: readWorkspaceDocuments(target).map((entry) => entry.documentId),
        shadowed: [],
      })
    }
    if (url.endsWith('/documents')) {
      return Response.json({
        documents: readWorkspaceDocuments(target).map((entry) => ({
          path: entry.path,
          id: entry.documentId,
          kind: entry.kind,
          updatedAt: new Date().toISOString(),
        })),
      })
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

/** A popup that is really the receiver, one microtask away, talking back as KEEPER. */
function loopbackTo(target: LoroDoc): (url: string) => PopupHandle {
  const self = window.location.origin
  return (url) => {
    queueMicrotask(() => {
      history.replaceState(null, '', `/receive-transfer#${url.split('#')[1]}`)
      render(
        <ReceiveTransferPage
          daemonToken="t"
          fetchFn={keeperStub(target)}
          passkeyCredentials={fakePasskey()}
          opener={{
            postMessage: (data, targetOrigin) => {
              if (targetOrigin !== self) return
              window.dispatchEvent(new MessageEvent('message', { origin: KEEPER, data }))
            },
          }}
        />,
      )
    })
    return {
      closed: false,
      postMessage: (data, targetOrigin) => {
        if (targetOrigin !== KEEPER) return
        window.dispatchEvent(new MessageEvent('message', { origin: self, data }))
      },
    }
  }
}

const returnTo = window.location.pathname

beforeEach(async () => {
  await clearWhiteboardDb()
  localStorage.setItem(
    PASSKEYS_KEY,
    JSON.stringify({
      [window.location.origin]: { credentialId: b64u(RAW_ID), registeredAt: 'x' },
    }),
  )
})
afterEach(() => {
  cleanup()
  localStorage.removeItem(PASSKEYS_KEY)
  history.replaceState(null, '', returnTo)
})

describe('TransferToKeeperSection', () => {
  it('sends the browser workspace to a keeper that receives it, end to end', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    const note = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/roadmap',
      kind: 'markdown',
    })
    const keeper = new LoroDoc()
    render(<TransferToKeeperSection openWindow={loopbackTo(keeper)} />)

    await userEvent.fill(screen.getByTestId('transfer-keeper-address'), KEEPER)
    await userEvent.click(screen.getByTestId('transfer-send'))
    // The receiver's own confirmation, at the destination.
    await userEvent.click(await screen.findByTestId('receive-transfer-accept'))

    await waitFor(() =>
      expect(screen.getByTestId('transfer-report').textContent).toMatch(/Sent 1 document\./),
    )
    // Landed: read back from the destination's own record, not the report.
    expect(readWorkspaceDocuments(keeper).map((e) => e.documentId)).toEqual([note.documentId])
    expect(screen.getByTestId('transfer-report').textContent).toMatch(
      /This browser still has its copy/,
    )
  })

  it('says a blocked window is something to allow, rather than waiting forever', async () => {
    render(<TransferToKeeperSection openWindow={() => null} />)
    await userEvent.fill(screen.getByTestId('transfer-keeper-address'), KEEPER)
    await userEvent.click(screen.getByTestId('transfer-send'))
    await waitFor(() =>
      expect(screen.getByTestId('transfer-report').textContent).toMatch(/blocked/i),
    )
  })

  it('refuses a plain-http remote address before opening anything', async () => {
    let opened = 0
    render(
      <TransferToKeeperSection
        openWindow={() => {
          opened += 1
          return null
        }}
      />,
    )
    await userEvent.fill(screen.getByTestId('transfer-keeper-address'), 'http://keeper.example')
    expect(screen.getByTestId('transfer-keeper-address-error').textContent).toMatch(/https/)
    expect((screen.getByTestId('transfer-send') as HTMLButtonElement).disabled).toBe(true)
    expect(opened).toBe(0)
  })
})
