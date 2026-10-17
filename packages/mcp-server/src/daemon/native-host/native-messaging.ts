/**
 * The framing a browser speaks to a native messaging host over stdio: each
 * message is a 32-bit length in the machine's byte order, then that many
 * bytes of UTF-8 JSON. Every platform the host ships for is little-endian.
 * https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-protocol
 */
import type { Readable } from 'node:stream'
import { PROMOTE_REQUEST_LIMIT_BYTES } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'

export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  return Buffer.concat([head, body])
}

/**
 * The longest frame the host will buffer from the browser. The largest body the
 * daemon takes is a workspace promotion, which the page sends base64-encoded
 * inside one request frame; the rest of the frame is a few fields. Chrome
 * sends a host at most 64 MiB, so this is also below anything it could send.
 * https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-protocol
 */
export const MAX_INBOUND_FRAME_BYTES = Math.ceil(PROMOTE_REQUEST_LIMIT_BYTES / 3) * 4 + 64 * 1024

/**
 * The pieces read so far, held as they arrived and joined once per frame, so a
 * frame cut into many pieces costs time linear in its size.
 */
class FrameReader {
  private readonly pieces: Buffer[] = []
  private buffered = 0
  /** The body length of the frame being read, once its head has arrived. */
  private expected: number | undefined

  constructor(private readonly maxFrameBytes: number) {}

  push(piece: Buffer): void {
    this.pieces.push(piece)
    this.buffered += piece.length
  }

  /** The next whole frame's body, `undefined` until one has arrived, or `'too-long'`. */
  next(): Buffer | undefined | 'too-long' {
    if (this.expected === undefined) {
      if (this.buffered < 4) return undefined
      this.expected = this.take(4).readUInt32LE(0)
      if (this.expected > this.maxFrameBytes) return 'too-long'
    }
    if (this.buffered < this.expected) return undefined
    const body = this.take(this.expected)
    this.expected = undefined
    return body
  }

  /** The next `size` buffered bytes, removed from the front. */
  private take(size: number): Buffer {
    const taken: Buffer[] = []
    let missing = size
    let used = 0
    while (missing > 0) {
      const head = this.pieces[used] as Buffer
      if (head.length <= missing) {
        taken.push(head)
        used += 1
        missing -= head.length
      } else {
        taken.push(head.subarray(0, missing))
        this.pieces[used] = head.subarray(missing)
        missing = 0
      }
    }
    // One removal per frame: shifting each piece off would be quadratic again.
    this.pieces.splice(0, used)
    this.buffered -= size
    return taken.length === 1 ? (taken[0] as Buffer) : Buffer.concat(taken, size)
  }
}

/** A frame's message, or `undefined` for one that is not JSON. */
function parseFrame(body: Buffer): { message: unknown } | undefined {
  try {
    return { message: JSON.parse(body.toString('utf8')) }
  } catch {
    return undefined
  }
}

/**
 * Hands each message on `input` to `onMessage` as the pieces arrive, and
 * settles when the input ends — which is the browser closing the port.
 *
 * A declared length past `maxFrameBytes` ends the port instead: the length is
 * the peer's to declare, and nothing after a frame left unread can be told
 * apart from its body.
 */
export function readNativeMessages(
  input: Readable,
  onMessage: (message: unknown) => void,
  { maxFrameBytes = MAX_INBOUND_FRAME_BYTES }: { maxFrameBytes?: number } = {},
): Promise<void> {
  const reader = new FrameReader(maxFrameBytes)
  const onData = (piece: Buffer) => {
    reader.push(piece)
    for (let body = reader.next(); body !== undefined; body = reader.next()) {
      if (body === 'too-long') {
        input.off('data', onData)
        input.destroy()
        return
      }
      // A frame that is not JSON carries no id to answer, so it is dropped
      // rather than allowed to end every other request on the port.
      const parsed = parseFrame(body)
      if (parsed !== undefined) onMessage(parsed.message)
    }
  }
  input.on('data', onData)
  return new Promise((resolve) => {
    input.once('end', resolve)
    input.once('close', resolve)
  })
}
