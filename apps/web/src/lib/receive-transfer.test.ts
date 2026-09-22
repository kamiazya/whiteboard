/**
 * The receiving side's gate: which messages it will act on at all.
 *
 * Every case here is a REFUSAL, because the gate is the only thing standing
 * between an arriving `postMessage` and a CRDT merge into somebody's
 * workspace. `event.origin` is set by the browser and cannot be forged, so
 * comparing against it is the whole mechanism — and a comparison that is
 * skipped, or made against the wrong thing, looks exactly like one that
 * passed.
 */
import { describe, expect, it } from 'vitest'
import {
  CROSS_ORIGIN_TRANSFER_PROTOCOL,
  transferWindowUrl,
} from './cross-origin-transfer-protocol.js'
import {
  openTransferSession,
  readOfferedTransfer,
  type TransferSession,
} from './receive-transfer.js'

const NONCE = 'n'.repeat(32)
const SENDER = 'https://app.example'

const sessionFor = (hash?: string): TransferSession => {
  const session = openTransferSession(
    hash ?? `#${new URLSearchParams({ from: SENDER, nonce: NONCE }).toString()}`,
  )
  if (session === null) throw new Error('expected a session for a well-formed fragment')
  return session
}

const offer = (over: Record<string, unknown> = {}) => ({
  type: 'transfer-offer',
  protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
  nonce: NONCE,
  snapshot: Uint8Array.from([1, 2, 3]),
  documentCount: 2,
  sourceWorkspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  ...over,
})

describe('opening a transfer session from this window own URL', () => {
  it('reads the sender origin and the nonce the opener put in the fragment', () => {
    const session = sessionFor()
    expect(session.senderOrigin).toBe(SENDER)
    expect(session.nonce).toBe(NONCE)
  })

  it('refuses to open at all when the fragment is absent or malformed', () => {
    // No session means the page has nothing to talk to and must say so,
    // rather than listening for a message it cannot attribute.
    expect(openTransferSession('')).toBeNull()
    expect(openTransferSession('#from=not-an-origin&nonce=' + NONCE)).toBeNull()
    expect(openTransferSession(`#from=${SENDER}`)).toBeNull()
  })

  it('opens from the URL the SENDER builds, so the two halves cannot disagree', () => {
    const url = transferWindowUrl('https://keeper.example', { senderOrigin: SENDER, nonce: NONCE })
    const session = openTransferSession(`#${url.split('#')[1]}`)
    expect(session).toEqual({ senderOrigin: SENDER, nonce: NONCE })
  })
})

describe('reading an offered transfer', () => {
  it('accepts an offer from the expected origin, with this attempt nonce and a protocol it speaks', () => {
    const read = readOfferedTransfer(sessionFor(), { origin: SENDER, data: offer() })
    expect(read.kind).toBe('offer')
    if (read.kind !== 'offer') return
    expect(read.documentCount).toBe(2)
    expect(read.sourceWorkspaceId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect([...read.snapshot]).toEqual([1, 2, 3])
  })

  it('IGNORES an offer from another origin, however well-formed its body', () => {
    // Origin decides whether this conversation is this session's AT ALL, so a
    // mismatch is not an event to report. Any page can `postMessage` to any
    // window it has a handle to; refusing visibly would let any origin raise
    // an error on this page, and the person it would be shown to has no
    // action to take. `event.origin` is the browser's word and the body can
    // claim anything, which is why the check is here and not on the body.
    const read = readOfferedTransfer(sessionFor(), {
      origin: 'https://attacker.example',
      data: offer(),
    })
    expect(read.kind).toBe('ignored')
  })

  it('refuses an offer carrying another attempt nonce, so a stale window cannot answer', () => {
    const read = readOfferedTransfer(sessionFor(), {
      origin: SENDER,
      data: offer({ nonce: 'x'.repeat(32) }),
    })
    expect(read.kind).toBe('refused')
    if (read.kind !== 'refused') return
    expect(read.reason).toMatch(/nonce|attempt/i)
  })

  it('refuses a protocol it does not speak, and names the two versions', () => {
    // The two halves deploy independently — a hosted app and whatever keeper
    // someone runs — so they WILL be different versions in the field, and a
    // person needs to be told which side to update.
    const read = readOfferedTransfer(sessionFor(), {
      origin: SENDER,
      data: offer({ protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL + 1 }),
    })
    expect(read.kind).toBe('refused')
    if (read.kind !== 'refused') return
    expect(read.reason).toContain(String(CROSS_ORIGIN_TRANSFER_PROTOCOL + 1))
    expect(read.reason).toContain(String(CROSS_ORIGIN_TRANSFER_PROTOCOL))
  })

  it('ignores a message that is not an offer at all, rather than refusing it', () => {
    // A window receives plenty of traffic it did not ask for — extensions,
    // frameworks, its own tooling. Refusing those would show a person an
    // error for something that is not about them; only a message that IS an
    // offer and fails a check is a refusal.
    for (const data of [
      { type: 'transfer-ready', protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL, nonce: NONCE },
      { type: 'webpack/hot-update' },
      'a string',
      null,
    ]) {
      expect(readOfferedTransfer(sessionFor(), { origin: SENDER, data }).kind, String(data)).toBe(
        'ignored',
      )
    }
  })

  it('checks the origin BEFORE the body, so a malformed offer from elsewhere is still only ignored', () => {
    // Ordering matters: were the body parsed first, a wrong-origin message
    // with a broken body would report a parse failure — telling a person
    // about a message that was never theirs, and in the wrong words.
    const read = readOfferedTransfer(sessionFor(), {
      origin: 'https://attacker.example',
      data: { type: 'transfer-offer', nonce: 'too-short' },
    })
    expect(read.kind).toBe('ignored')
  })

  it('refuses an offer from the RIGHT origin whose body does not parse, since that one is addressed here', () => {
    const read = readOfferedTransfer(sessionFor(), {
      origin: SENDER,
      data: { type: 'transfer-offer', nonce: NONCE, protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL },
    })
    expect(read.kind).toBe('refused')
    if (read.kind !== 'refused') return
    expect(read.reason).toMatch(/could not be read|malformed|unexpected/i)
  })
})
