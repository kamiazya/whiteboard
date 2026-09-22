/**
 * The sending half of a cross-origin workspace transfer: open a window at the
 * destination keeper's origin, hand it the record once it says it is ready,
 * and wait for what it reports back.
 *
 * Why a window at all is `cross-origin-transfer-protocol.ts`'s header: this
 * app's `connect-src` cannot reach an arbitrary keeper, and a page AT that
 * keeper is under no such rule — it merges same-origin, with its own passkey.
 *
 * TWO CHECKS DO ALL THE WORK, and both are on the browser's word rather than
 * on anything a message says about itself:
 *
 * - **Only the destination's origin is listened to.** Any window can
 *   `postMessage` to this one, so without the check a page elsewhere could
 *   report a transfer as done — the person would believe their workspace had
 *   moved when nothing had.
 * - **The offer is posted to the destination's exact origin, never `'*'`.**
 *   If the popup has navigated away by the time it is ready, the browser
 *   drops the message instead of handing the workspace to whatever loaded.
 *
 * The nonce binds a reply to this attempt, so a stale window from an earlier
 * try cannot settle a new one.
 */
import {
  CROSS_ORIGIN_TRANSFER_PROTOCOL,
  type TransferResponse,
  transferResponseSchema,
  transferWindowUrl,
} from './cross-origin-transfer-protocol.js'

/** The part of a `Window` this needs — what `window.open` returns, minus the rest. */
export interface PopupHandle {
  postMessage(message: unknown, targetOrigin: string): void
  readonly closed: boolean
}

export type SendTransferResult =
  | Omit<Extract<TransferResponse, { ok: true }>, 'type' | 'nonce'>
  | { ok: false; reason: string }

/** What the offer carries, read from this browser's own record. */
export interface TransferPayload {
  snapshot: Uint8Array
  /** For the receiver's confirmation copy; it reports what REALLY merged. */
  documentCount: number
  sourceWorkspaceId: string
}

export interface SendTransferOptions {
  /** The destination keeper, as the person gave it. */
  keeperBaseUrl: string
  /** This app's own origin — what the receiver will check every message against. */
  senderOrigin: string
  /**
   * A PROMISE of the payload, not the payload. `window.open` must run in the
   * same task as the click or a popup blocker refuses it, and reading the
   * record is an IndexedDB round trip — awaiting it first can outlive the
   * click's user activation. So the window opens synchronously here and the
   * read runs while the destination loads; it is awaited only once the
   * destination says it is ready.
   */
  payload: Promise<TransferPayload>
  /** Seams. Production: a fresh random nonce, and `window.open`. */
  nonce?: string
  openWindow?: (url: string) => PopupHandle | null
  closedPollMs?: number
}

/** Unguessable enough that another window at the same keeper cannot answer for this attempt. */
function freshNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

export function sendTransfer(options: SendTransferOptions): Promise<SendTransferResult> {
  const destination = new URL(options.keeperBaseUrl).origin
  const nonce = options.nonce ?? freshNonce()
  const url = transferWindowUrl(options.keeperBaseUrl, {
    senderOrigin: options.senderOrigin,
    nonce,
  })
  const open = options.openWindow ?? ((target: string) => globalThis.open(target, '_blank'))
  const popup = open(url)
  // The payload is already being read, and several exits never consume it —
  // a blocked window, a window closed before ready, a protocol refusal. A
  // rejection nobody handles surfaces as an unhandled error in the console,
  // so it is marked handled here; the offer path still sees its own failure.
  options.payload.catch(() => undefined)
  if (popup === null) {
    return Promise.resolve({
      ok: false,
      reason:
        'The browser blocked the window the transfer needs. Allow pop-ups for this page and try again.',
    })
  }

  let offered = false
  return talkTo<SendTransferResult>(popup, options.closedPollMs ?? 500, {
    onMessage: (event, talk) => {
      const read = readHandshakeMessage(event, destination, nonce)
      if (read.kind === 'result') talk.settle(read.result)
      else if (read.kind === 'ready' && !offered) {
        offered = true
        offerRecord(talk, read.protocol, { popup, destination, nonce, payload: options.payload })
      }
    },
    onClosed: (talk) =>
      talk.settle({
        ok: false,
        reason: offered
          ? 'The window was closed before the keeper reported back. Check the destination before trying again — the transfer may have landed.'
          : 'The window was closed before the transfer started, so nothing was sent.',
      }),
  })
}

interface Talk<T> {
  settle(result: T): void
  readonly settled: boolean
}

/**
 * A conversation with a window this page opened: every message is handed to
 * `onMessage` until something settles, the window closing is handed to
 * `onClosed`, and the answer is taken once — after which the listener and the
 * watch are gone. The lifetime lives here so the protocol above says only
 * what to answer.
 *
 * ponytail: a window has no "closed" event, so this polls `popup.closed`; a
 * person may sit in the popup for as long as their passkey takes, so there is
 * deliberately no timeout — closing the window IS the cancel.
 */
function talkTo<T>(
  popup: PopupHandle,
  pollMs: number,
  handlers: {
    onMessage(event: MessageEvent, talk: Talk<T>): void
    onClosed(talk: Talk<T>): void
  },
): Promise<T> {
  return new Promise((resolve) => {
    let done = false
    const talk: Talk<T> = {
      get settled() {
        return done
      },
      settle(result) {
        done = true
        globalThis.removeEventListener('message', onMessage)
        clearInterval(closedWatch)
        resolve(result)
      },
    }
    const onMessage = (event: MessageEvent): void => handlers.onMessage(event, talk)
    globalThis.addEventListener('message', onMessage)
    const closedWatch = setInterval(() => {
      if (popup.closed) handlers.onClosed(talk)
    }, pollMs)
  })
}

/** Answers the destination's ready: refuse a protocol this app does not speak, else post the record. */
function offerRecord(
  talk: Talk<SendTransferResult>,
  protocol: unknown,
  to: {
    popup: PopupHandle
    destination: string
    nonce: string
    payload: Promise<TransferPayload>
  },
): void {
  if (protocol !== CROSS_ORIGIN_TRANSFER_PROTOCOL) {
    talk.settle({ ok: false, reason: protocolRefusal(protocol) })
    return
  }
  void to.payload.then(
    (payload) => {
      // The person may have closed the window while the record was read.
      if (talk.settled) return
      to.popup.postMessage(
        {
          type: 'transfer-offer',
          protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
          nonce: to.nonce,
          ...payload,
        },
        to.destination,
      )
    },
    () =>
      talk.settle({
        ok: false,
        reason: "This browser's workspace could not be read, so nothing was sent.",
      }),
  )
}

type HandshakeMessage =
  | { kind: 'ignore' }
  | { kind: 'ready'; protocol: unknown }
  | { kind: 'result'; result: SendTransferResult }

/**
 * What an arriving message means for THIS attempt. Everything not from the
 * destination's origin, or carrying another attempt's nonce, is ignored — the
 * two checks the module header names, taken here and nowhere else.
 */
function readHandshakeMessage(
  event: MessageEvent,
  destination: string,
  nonce: string,
): HandshakeMessage {
  if (event.origin !== destination) return { kind: 'ignore' }
  const data = event.data as { type?: unknown; nonce?: unknown; protocol?: unknown } | null
  if (typeof data !== 'object' || data === null || data.nonce !== nonce) return { kind: 'ignore' }
  if (data.type === 'transfer-ready') return { kind: 'ready', protocol: data.protocol }
  if (data.type !== 'transfer-result') return { kind: 'ignore' }
  const parsed = transferResponseSchema.safeParse(data)
  if (!parsed.success) {
    return {
      kind: 'result',
      result: { ok: false, reason: 'The keeper answered with a result this app could not read.' },
    }
  }
  const { type: _type, nonce: _nonce, ...result } = parsed.data
  return { kind: 'result', result }
}

/** Both versions, because the two halves deploy independently and a person has to know which to update. */
function protocolRefusal(protocol: unknown): string {
  return `That keeper speaks transfer protocol ${String(protocol)} and this app speaks ${CROSS_ORIGIN_TRANSFER_PROTOCOL}. Update whichever is older and try again.`
}

/**
 * What a person typed as the destination, checked before a window is opened
 * for it.
 *
 * https everywhere, and plain http only for a keeper on this machine: the
 * record crosses in a `postMessage` and then an upload the destination makes
 * itself, and neither should be readable on the wire to anyone between here
 * and a remote host. This app's own origin is refused because sending a
 * workspace to the keeper it already lives in is not a transfer.
 */
export function parseDestination(
  input: string,
  selfOrigin: string,
): { ok: true; keeperBaseUrl: string } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return { ok: false, reason: 'Enter the keeper’s full address, starting with https://.' }
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return {
      ok: false,
      reason: 'Use an https:// address — http is only for a keeper on this machine.',
    }
  }
  if (url.origin === selfOrigin) {
    return { ok: false, reason: 'That is this app’s own address; choose the keeper to send to.' }
  }
  return { ok: true, keeperBaseUrl: `${url.origin}${url.pathname}`.replace(/\/$/, '') }
}
