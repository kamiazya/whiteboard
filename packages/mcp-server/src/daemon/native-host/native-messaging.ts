/**
 * The framing a browser speaks to a native messaging host over stdio: each
 * message is a 32-bit length in the machine's byte order, then that many
 * bytes of UTF-8 JSON. Every platform the host ships for is little-endian.
 * https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-protocol
 */
import type { Readable } from 'node:stream'

export function encodeNativeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  return Buffer.concat([head, body])
}

/**
 * Hands each message on `input` to `onMessage` as the pieces arrive, and
 * settles when the input ends — which is the browser closing the port.
 */
export function readNativeMessages(
  input: Readable,
  onMessage: (message: unknown) => void,
): Promise<void> {
  let pending = Buffer.alloc(0)
  input.on('data', (piece: Buffer) => {
    pending = Buffer.concat([pending, piece])
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0)
      if (pending.length < 4 + length) break
      const body = pending.subarray(4, 4 + length).toString('utf8')
      pending = pending.subarray(4 + length)
      // A frame that is not JSON carries no id to answer, so it is dropped
      // rather than allowed to end every other request on the port.
      let message: unknown
      try {
        message = JSON.parse(body)
      } catch {
        continue
      }
      onMessage(message)
    }
  })
  return new Promise((resolve) => {
    input.once('end', resolve)
    input.once('close', resolve)
  })
}
