/**
 * The browser's native messaging framing: a 4-byte length in the machine's
 * byte order, then that many bytes of UTF-8 JSON. The stream arrives in
 * whatever pieces the pipe hands over, so the reader has to reassemble.
 */
import { PassThrough } from 'node:stream'
import { PROMOTE_REQUEST_LIMIT_BYTES } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import {
  encodeNativeMessage,
  MAX_INBOUND_FRAME_BYTES,
  readNativeMessages,
} from './native-messaging.js'

async function collect(pieces: readonly Buffer[]): Promise<unknown[]> {
  const input = new PassThrough()
  const seen: unknown[] = []
  const done = readNativeMessages(input, (message) => {
    seen.push(message)
  })
  for (const piece of pieces) input.write(piece)
  input.end()
  await done
  return seen
}

describe('native messaging frames', () => {
  fcTest.prop(
    [
      fc.array(fc.jsonValue(), { minLength: 1, maxLength: 8 }),
      fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 16 }),
    ],
    withDefaults(),
  )('reads back every message, however the stream is cut', async (messages, cuts) => {
    const bytes = Buffer.concat(messages.map(encodeNativeMessage))
    const pieces: Buffer[] = []
    let at = 0
    for (let i = 0; at < bytes.length; i += 1) {
      const size = cuts[i % cuts.length] ?? 1
      pieces.push(bytes.subarray(at, at + size))
      at += size
    }
    expect(await collect(pieces)).toEqual(messages.map((m) => JSON.parse(JSON.stringify(m))))
  })

  it('writes the length in the machine byte order the browser reads', () => {
    const frame = encodeNativeMessage({ a: 1 })
    const length = Buffer.byteLength(JSON.stringify({ a: 1 }))
    expect(frame.readUInt32LE(0)).toBe(length)
  })
})

const lengthHead = (length: number) => {
  const head = Buffer.alloc(4)
  head.writeUInt32LE(length)
  return head
}

describe('a frame the host will not buffer', () => {
  afterEach(() => vi.restoreAllMocks())

  // The length is the peer's to declare, so a reader that waits for 4 GiB to
  // arrive holds whatever arrives until then. Nothing after an unread frame
  // can be told apart from its body, so the port ends.
  it('ends the port on a declared length past the ceiling, delivering nothing of it', async () => {
    const input = new PassThrough()
    const seen: unknown[] = []
    const done = readNativeMessages(input, (message) => {
      seen.push(message)
    })
    input.write(Buffer.concat([encodeNativeMessage({ before: true }), lengthHead(0xff_ff_ff_ff)]))
    input.write(Buffer.alloc(1024))
    await vi.waitFor(() => expect(input.destroyed).toBe(true))
    await done
    expect(seen).toEqual([{ before: true }])
  })

  it('reads a frame of exactly the ceiling and refuses one byte more', async () => {
    const body = JSON.stringify('x'.repeat(30))
    const input = new PassThrough()
    const seen: unknown[] = []
    const done = readNativeMessages(input, (m) => seen.push(m), { maxFrameBytes: body.length })
    input.write(Buffer.concat([lengthHead(body.length), Buffer.from(body)]))
    input.write(lengthHead(body.length + 1))
    await vi.waitFor(() => expect(input.destroyed).toBe(true))
    await done
    expect(seen).toEqual(['x'.repeat(30)])
  })

  // Chrome caps what it sends a host at 64 MiB; the largest body the daemon
  // takes is a workspace promotion, base64-encoded inside the request frame.
  it('sits between the largest request the daemon takes and what Chrome sends', () => {
    expect(MAX_INBOUND_FRAME_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(MAX_INBOUND_FRAME_BYTES).toBeGreaterThan(Math.ceil(PROMOTE_REQUEST_LIMIT_BYTES / 3) * 4)
  })

  // Re-joining everything buffered on every piece copies a frame once per
  // piece it arrived in: quadratic in the piece count.
  it('copies a frame cut into many pieces a bounded number of times', async () => {
    const message = { data: 'y'.repeat(256 * 1024) }
    const frame = encodeNativeMessage(message)
    const concat = vi.spyOn(Buffer, 'concat')
    const pieces: Buffer[] = []
    for (let at = 0; at < frame.length; at += 64) pieces.push(frame.subarray(at, at + 64))
    expect(pieces.length).toBeGreaterThan(4000)

    const seen = await collect(pieces)

    expect(seen).toEqual([message])
    const copied = concat.mock.results.reduce(
      (sum, result) => sum + (result.value as Buffer).length,
      0,
    )
    expect(concat).toHaveBeenCalled()
    expect(copied).toBeLessThanOrEqual(3 * frame.length)
  })
})
