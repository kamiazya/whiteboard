/**
 * The browser's native messaging framing: a 4-byte length in the machine's
 * byte order, then that many bytes of UTF-8 JSON. The stream arrives in
 * whatever pieces the pipe hands over, so the reader has to reassemble.
 */
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { encodeNativeMessage, readNativeMessages } from './native-messaging.js'

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
