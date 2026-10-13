import { describe, expect, it } from 'vitest'
import { FetchFailedError, reach, readJsonOrUndefined } from './read-body.js'

/** A body whose stream errors after its first bytes, as a connection cut mid-read does. */
function cutBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'))
      controller.error(new TypeError('network error'))
    },
  })
}

describe('readJsonOrUndefined', () => {
  it('answers the parsed body', async () => {
    expect(await readJsonOrUndefined(new Response('{"a":1}'))).toEqual({ a: 1 })
  })

  it('answers undefined for a body that arrived and is not JSON', async () => {
    expect(await readJsonOrUndefined(new Response('<html>bad gateway</html>'))).toBeUndefined()
    expect(await readJsonOrUndefined(new Response(null))).toBeUndefined()
  })

  it('names a body cut mid-stream the network failure', async () => {
    await expect(readJsonOrUndefined(new Response(cutBody()))).rejects.toBeInstanceOf(
      FetchFailedError,
    )
  })
})

describe('reach', () => {
  it('passes a settled value through and names a rejection, keeping its cause', async () => {
    expect(await reach(Promise.resolve(1))).toBe(1)
    const cause = new TypeError('Failed to fetch')
    const failure = await reach(Promise.reject(cause)).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(FetchFailedError)
    expect((failure as FetchFailedError).cause).toBe(cause)
  })
})
