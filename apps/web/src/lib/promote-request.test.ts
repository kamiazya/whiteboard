/**
 * The one promote request both moves send — the daemon move and the
 * cross-origin receiver — so every rule about what an older keeper can read
 * is stated, and pinned, once.
 */
import type { PromotedVersion } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { type PromoteWording, requestPromote } from './promote-request.js'

const WORDING: PromoteWording = {
  subject: 'This keeper',
  object: 'the keeper',
  refused: (status) => `This keeper refused the merge (${status}).`,
  unexpected: 'This keeper answered the merge with an unexpected response.',
}

const VERSION: PromotedVersion = {
  id: 'v-1',
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  createdAt: 1_000,
  auto: false,
  frontiers: 'AA',
}
const TRASHED = { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', bytes: 'AQID' }

function keeper(handlers: {
  promote: () => Response | Promise<Response>
  list?: () => Response | Promise<Response>
}) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/workspace-document/promote')) return handlers.promote()
    if (url.endsWith('/documents') && handlers.list) return handlers.list()
    throw new Error(`unexpected fetch: ${url}`)
  })
}

const request = (
  fetch: ReturnType<typeof keeper>,
  planes: Parameters<typeof requestPromote>[0]['planes'] = {},
) =>
  requestPromote({
    fetch: fetch as unknown as typeof globalThis.fetch,
    keeperBaseUrl: 'https://keeper.example',
    workspaceId: 'ws-here',
    snapshot: 'AQID',
    planes,
    wording: WORDING,
  })

const sentBody = (fetch: ReturnType<typeof keeper>) =>
  JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body))

describe('requestPromote', () => {
  it('leaves an empty plane out of the body, so a keeper predating the planes reads it', async () => {
    const fetch = keeper({
      promote: () => jsonResponse({ ok: true, recorded: [], shadowed: [] }),
      list: () => jsonResponse({ documents: [] }),
    })
    await request(fetch, { trash: [], versions: [] })
    expect(Object.keys(sentBody(fetch))).toEqual(['snapshot'])
  })

  it('posts the planes it was given, to the keeper the base URL names', async () => {
    const fetch = keeper({
      promote: () =>
        jsonResponse({
          ok: true,
          recorded: [],
          shadowed: [],
          trashStored: [TRASHED.documentId],
          versionsKept: ['v-1'],
        }),
      list: () => jsonResponse({ documents: [] }),
    })
    const result = await request(fetch, { trash: [TRASHED], versions: [VERSION] })
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://keeper.example/api/w/ws-here/workspace-document/promote',
    )
    expect(sentBody(fetch)).toEqual({ snapshot: 'AQID', trash: [TRASHED], versions: [VERSION] })
    expect(result).toEqual({ ok: true, shadowedPaths: [], leftBehind: [] })
  })

  it('names what the keeper did not read back of what was sent', async () => {
    const fetch = keeper({
      promote: () => jsonResponse({ ok: true, recorded: [], shadowed: [] }),
      list: () => jsonResponse({ documents: [] }),
    })
    expect(await request(fetch, { trash: [TRASHED], versions: [VERSION] })).toEqual({
      ok: true,
      shadowedPaths: [],
      leftBehind: [
        '1 trashed document did not reach the keeper',
        '1 saved version did not reach the keeper',
      ],
    })
  })

  it('reports the shadowed paths the keeper lists, and none when that read fails', async () => {
    const promote = () => jsonResponse({ ok: true, recorded: [], shadowed: [] })
    const listed = keeper({
      promote,
      list: () =>
        jsonResponse({
          documents: [
            {
              documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
              path: 'a',
              kind: 'markdown',
              shadowed: true,
            },
            { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', path: 'b', kind: 'markdown' },
          ],
        }),
    })
    expect(await request(listed)).toMatchObject({ ok: true, shadowedPaths: ['a'] })
    const unlisted = keeper({ promote, list: () => new Response('down', { status: 503 }) })
    expect(await request(unlisted)).toMatchObject({ ok: true, shadowedPaths: [] })
  })

  it('says to update the keeper when it refuses the shape of a body carrying planes', async () => {
    const fetch = keeper({
      promote: () => jsonResponse({ error: 'invalid_body', message: 'unrecognized key' }, 400),
    })
    expect(await request(fetch, { versions: [VERSION] })).toEqual({
      ok: false,
      reason:
        'This keeper refused the trash and saved versions sent with the workspace (unrecognized key). If the keeper is older than this page, update it and move again.',
    })
  })

  it('passes a refusal of the carried planes themselves through as the keeper said it', async () => {
    const fetch = keeper({
      promote: () =>
        jsonResponse(
          {
            error: 'unmatched_carried',
            message: 'Version "v1" names a point the record does not hold.',
          },
          400,
        ),
    })
    expect(await request(fetch, { versions: [VERSION] })).toEqual({
      ok: false,
      reason: 'Version "v1" names a point the record does not hold.',
    })
  })

  it('passes a shape refusal of a body carrying no planes through as the keeper said it', async () => {
    const fetch = keeper({
      promote: () => jsonResponse({ error: 'invalid_body', message: 'unrecognized key' }, 400),
    })
    expect(await request(fetch)).toEqual({ ok: false, reason: 'unrecognized key' })
  })

  it('falls back to the caller wording for a refusal that states no reason', async () => {
    const fetch = keeper({
      promote: () => new Response('<html>bad gateway</html>', { status: 502 }),
    })
    expect(await request(fetch)).toEqual({
      ok: false,
      reason: 'This keeper refused the merge (502).',
    })
  })

  it('reports an answer that fails the promote contract in the caller wording, and logs it', async () => {
    const fetch = keeper({ promote: () => jsonResponse({ ok: true, recorded: 'yes' }) })
    expect(await request(fetch)).toEqual({
      ok: false,
      reason: 'This keeper answered the merge with an unexpected response.',
    })
    await expectLoggedFailure('/workspace-document/promote failed its contract at recorded')
  })

  it('rejects as an unreached keeper when an accepted answer is cut mid-body', async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":tr'))
        controller.error(new TypeError('network error'))
      },
    })
    const fetch = keeper({ promote: () => new Response(cut, { status: 200 }) })
    // A dropped connection is the network's, not the keeper's contract: it
    // must reach the caller's network sentence, and leave no drift record.
    await expect(request(fetch)).rejects.toMatchObject({ name: 'FetchFailedError' })
  })

  it('reads an accepted answer that is not JSON as contract drift, not as the network', async () => {
    const fetch = keeper({ promote: () => new Response('<html>', { status: 200 }) })
    expect(await request(fetch)).toEqual({
      ok: false,
      reason: 'This keeper answered the merge with an unexpected response.',
    })
    await expectLoggedFailure('/workspace-document/promote failed its contract at (root)')
  })
})
