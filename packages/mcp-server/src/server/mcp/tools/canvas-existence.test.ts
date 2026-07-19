import { describe, it, expect } from 'vitest'
import type { DaemonClient } from '../daemon-client.js'
import { assertCanvasExists } from './canvas-existence.js'

function makeClient(request: DaemonClient['request']): DaemonClient {
  return {
    port: 3099,
    baseUrl: 'http://localhost:3099',
    request,
    touch: async () => undefined,
  }
}

describe('assertCanvasExists', () => {
  it('resolves without throwing when the canvas exists', async () => {
    const client = makeClient(
      async () => new Response(JSON.stringify({ exists: true }), { status: 200 }),
    )
    await expect(assertCanvasExists(client, 'ws', 'slug')).resolves.toBeUndefined()
  })

  it('throws an actionable canvas_create hint when the canvas does not exist', async () => {
    const client = makeClient(
      async () => new Response(JSON.stringify({ exists: false }), { status: 200 }),
    )
    await expect(assertCanvasExists(client, 'ws', 'slug')).rejects.toThrow(
      /Canvas "ws\/slug" does not exist.*canvas_create.*slug "slug"/s,
    )
  })

  it('throws with the HTTP status when the daemon responds with a non-ok status', async () => {
    const client = makeClient(async () => new Response('boom', { status: 500 }))
    await expect(assertCanvasExists(client, 'ws', 'slug')).rejects.toThrow(
      'Failed to check canvas "ws/slug" existence: 500',
    )
  })
})
