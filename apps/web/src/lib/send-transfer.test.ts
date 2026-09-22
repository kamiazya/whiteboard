/**
 * The sending half's handshake, driven with a fake popup and real
 * `MessageEvent`s on this window.
 *
 * The cases that matter are the ones where the other side is NOT who it
 * should be: a result from another origin, a ready from another attempt, a
 * window that was closed or never opened. Each is a transfer that would
 * otherwise hang with no explanation or, worse, report somebody else's
 * outcome as this one's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CROSS_ORIGIN_TRANSFER_PROTOCOL } from './cross-origin-transfer-protocol.js'
import { type PopupHandle, parseDestination, sendTransfer } from './send-transfer.js'

const KEEPER = 'https://keeper.example'
const SELF = 'https://app.example'
const NONCE = 'n'.repeat(32)

function fakePopup(): PopupHandle & { posted: Array<[unknown, string]>; closed: boolean } {
  const posted: Array<[unknown, string]> = []
  return {
    posted,
    closed: false,
    postMessage(message: unknown, targetOrigin: string) {
      posted.push([message, targetOrigin])
    },
  }
}

function arrive(origin: string, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { origin, data }))
}

const baseOptions = (popup: PopupHandle | null) => ({
  keeperBaseUrl: `${KEEPER}/`,
  senderOrigin: SELF,
  nonce: NONCE,
  payload: Promise.resolve({
    snapshot: Uint8Array.from([1, 2, 3]),
    documentCount: 2,
    sourceWorkspaceId: 'ws-here',
  }),
  openWindow: vi.fn((_url: string) => popup),
  closedPollMs: 10,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sending a transfer through a window at the destination', () => {
  it('opens the destination at /receive-transfer with the handshake in the fragment', async () => {
    const popup = fakePopup()
    const options = baseOptions(popup)
    const sent = sendTransfer(options)
    expect(options.openWindow).toHaveBeenCalledWith(
      `${KEEPER}/receive-transfer#from=https%3A%2F%2Fapp.example&nonce=${NONCE}`,
    )
    popup.closed = true
    await sent
  })

  it('posts the offer only after the destination says it is ready, and only to that origin', async () => {
    const popup = fakePopup()
    const sent = sendTransfer(baseOptions(popup))
    // Nothing is posted before ready: a message to a window that has not run
    // its script yet is lost.
    expect(popup.posted).toEqual([])
    arrive(KEEPER, {
      type: 'transfer-ready',
      protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
      nonce: NONCE,
    })
    // The payload is awaited after ready, so the post lands a microtask later.
    await vi.waitFor(() => expect(popup.posted).toHaveLength(1))
    const [message, targetOrigin] = popup.posted[0] ?? []
    // The bytes go to the destination's exact origin: had the popup navigated
    // elsewhere, the browser would drop them rather than deliver them.
    expect(targetOrigin).toBe(KEEPER)
    expect(message).toMatchObject({ type: 'transfer-offer', nonce: NONCE, documentCount: 2 })

    arrive(KEEPER, {
      type: 'transfer-result',
      nonce: NONCE,
      ok: true,
      workspaceId: 'ws-there',
      promotedDocumentIds: ['a', 'b'],
      shadowedPaths: [],
      attested: true,
      imagesMissing: ['img-1'],
    })
    await expect(sent).resolves.toMatchObject({
      ok: true,
      workspaceId: 'ws-there',
      imagesMissing: ['img-1'],
    })
  })

  it('ignores a ready or a result from ANY other origin, so it cannot be spoofed', async () => {
    const popup = fakePopup()
    const sent = sendTransfer(baseOptions(popup))
    arrive('https://attacker.example', {
      type: 'transfer-ready',
      protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
      nonce: NONCE,
    })
    expect(popup.posted).toEqual([])
    arrive('https://attacker.example', {
      type: 'transfer-result',
      nonce: NONCE,
      ok: true,
      workspaceId: 'forged',
      promotedDocumentIds: [],
      shadowedPaths: [],
      attested: false,
    })
    popup.closed = true
    // The forged result did not resolve it; the closed window did.
    await expect(sent).resolves.toMatchObject({ ok: false })
  })

  it('ignores a result carrying another attempt nonce', async () => {
    const popup = fakePopup()
    const sent = sendTransfer(baseOptions(popup))
    arrive(KEEPER, {
      type: 'transfer-result',
      nonce: 'x'.repeat(32),
      ok: false,
      reason: 'someone else',
    })
    popup.closed = true
    await expect(sent).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/closed/i),
    })
  })

  it('says a destination on another protocol version which side to update', async () => {
    const popup = fakePopup()
    const sent = sendTransfer(baseOptions(popup))
    arrive(KEEPER, {
      type: 'transfer-ready',
      protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL + 1,
      nonce: NONCE,
    })
    const result = await sent
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain(String(CROSS_ORIGIN_TRANSFER_PROTOCOL + 1))
    // And nothing was offered to a destination that would misread it.
    expect(popup.posted).toEqual([])
  })

  it('opens the window BEFORE the payload is read, so a popup blocker sees the click', async () => {
    let release: (value: {
      snapshot: Uint8Array
      documentCount: number
      sourceWorkspaceId: string
    }) => void = () => {}
    const payload = new Promise<{
      snapshot: Uint8Array
      documentCount: number
      sourceWorkspaceId: string
    }>((resolve) => {
      release = resolve
    })
    const popup = fakePopup()
    const options = { ...baseOptions(popup), payload }
    const sent = sendTransfer(options)
    // Opened synchronously, while the record read is still outstanding.
    expect(options.openWindow).toHaveBeenCalledTimes(1)
    arrive(KEEPER, {
      type: 'transfer-ready',
      protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
      nonce: NONCE,
    })
    await Promise.resolve()
    expect(popup.posted).toEqual([])
    release({ snapshot: Uint8Array.from([9]), documentCount: 1, sourceWorkspaceId: 'ws-here' })
    await vi.waitFor(() => expect(popup.posted).toHaveLength(1))
    popup.closed = true
    await sent
  })

  it('does not send a record that finished reading after the window was closed', async () => {
    let release: (value: {
      snapshot: Uint8Array
      documentCount: number
      sourceWorkspaceId: string
    }) => void = () => {}
    const payload = new Promise<{
      snapshot: Uint8Array
      documentCount: number
      sourceWorkspaceId: string
    }>((resolve) => {
      release = resolve
    })
    const popup = fakePopup()
    const sent = sendTransfer({ ...baseOptions(popup), payload })
    arrive(KEEPER, {
      type: 'transfer-ready',
      protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
      nonce: NONCE,
    })
    popup.closed = true
    await expect(sent).resolves.toMatchObject({ ok: false })
    release({ snapshot: Uint8Array.from([9]), documentCount: 1, sourceWorkspaceId: 'ws-here' })
    await Promise.resolve()
    await Promise.resolve()
    expect(popup.posted).toEqual([])
  })

  it('leaves no unhandled rejection when a blocked window never consumes a failed read', async () => {
    // vitest fails the file on an unhandled rejection, so this case passing
    // at all is the assertion: a person whose browser keeps no record and
    // blocks the window must see one sentence, not a console error too.
    const result = await sendTransfer({
      ...baseOptions(null),
      payload: Promise.reject(new Error('no record')),
    })
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/blocked/i) })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('reports a blocked popup as something the person can act on', async () => {
    const result = await sendTransfer(baseOptions(null))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/blocked/i)
  })

  it('stops listening once settled, so a late ready cannot send a closed transfer', async () => {
    // Two things keep an abandoned transfer from posting: the listener goes
    // away, and the offer re-checks `settled` after the read. Each alone hides
    // the other's removal from `posted`, so the listener is asserted on
    // directly — a listener left behind per attempt is the leak itself.
    const added = vi.spyOn(globalThis, 'addEventListener')
    const removed = vi.spyOn(globalThis, 'removeEventListener')
    try {
      const popup = fakePopup()
      const sent = sendTransfer(baseOptions(popup))
      const listener = added.mock.calls.find(([type]) => type === 'message')?.[1]
      expect(listener).toBeDefined()
      popup.closed = true
      await expect(sent).resolves.toMatchObject({
        ok: false,
        reason: expect.stringMatching(/nothing was sent/),
      })
      expect(removed).toHaveBeenCalledWith('message', listener)
      arrive(KEEPER, {
        type: 'transfer-ready',
        protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
        nonce: NONCE,
      })
      await Promise.resolve()
      expect(popup.posted).toEqual([])
    } finally {
      added.mockRestore()
      removed.mockRestore()
    }
  })
})

describe('checking the destination a person typed', () => {
  const SELF_ORIGIN = 'https://app.example'
  it('accepts an https keeper and normalises away a trailing slash', () => {
    expect(parseDestination('https://keeper.example/', SELF_ORIGIN)).toEqual({
      ok: true,
      keeperBaseUrl: 'https://keeper.example',
    })
  })
  it('accepts plain http only for a keeper on this machine', () => {
    expect(parseDestination('http://localhost:3099', SELF_ORIGIN).ok).toBe(true)
    expect(parseDestination('http://127.0.0.1:3099', SELF_ORIGIN).ok).toBe(true)
    expect(parseDestination('http://keeper.example', SELF_ORIGIN).ok).toBe(false)
  })
  it('refuses something that is not an address, and this app itself', () => {
    expect(parseDestination('keeper.example', SELF_ORIGIN).ok).toBe(false)
    expect(parseDestination('https://app.example/somewhere', SELF_ORIGIN).ok).toBe(false)
  })
})
