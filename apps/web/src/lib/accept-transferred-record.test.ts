/**
 * The receiving side's failure branches, each answered as a sentence.
 *
 * This is the only path that moves a whole workspace record between keepers,
 * so a refusal that reports success — or a failure that rejects the promise
 * instead of telling the sender — is the defect these cases stand against.
 * Every reason is asserted verbatim because the page shows it and the opener
 * is sent it.
 */
import { createWorkspaceDocumentAtPath } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { acceptTransferredRecord } from './accept-transferred-record.js'

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function validSnapshot(): Uint8Array {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: 'notes/roadmap',
    documentId: DOCUMENT_ID,
    kind: 'markdown',
  })
  record.commit()
  return new Uint8Array(record.export({ mode: 'snapshot' }))
}

const GARBAGE = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03])

const promoted = () => jsonResponse({ ok: true, attested: false, recorded: [], shadowed: [] })

function keeper(handlers: {
  promote: () => Response | Promise<Response>
  list?: () => Response | Promise<Response>
}) {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/workspace-document/promote')) return handlers.promote()
    if (url.endsWith('/documents') && handlers.list) return handlers.list()
    throw new Error(`unexpected fetch: ${url}`)
  })
}

const accept = (fetch: ReturnType<typeof keeper>, snapshot = validSnapshot()) =>
  acceptTransferredRecord({
    fetch: fetch as unknown as typeof globalThis.fetch,
    workspaceId: 'ws-here',
    snapshot,
  })

describe('acceptTransferredRecord refusals', () => {
  it.each([
    {
      name: 'a fetch that throws',
      fetch: () =>
        keeper({
          promote: () => {
            throw new TypeError('Failed to fetch')
          },
        }),
      reason: 'The workspace could not be merged here (unexpected failure).',
    },
    {
      name: 'a refusal carrying its own message',
      fetch: () =>
        keeper({
          promote: () =>
            jsonResponse(
              { error: 'forbidden', message: 'You may not merge into this workspace.' },
              403,
            ),
        }),
      reason: 'You may not merge into this workspace.',
    },
    {
      name: 'a refusal with no readable body',
      fetch: () =>
        keeper({ promote: () => new Response('<html>bad gateway</html>', { status: 502 }) }),
      reason: 'This keeper refused the merge (502).',
    },
    {
      name: 'a refusal whose body states no reason',
      fetch: () => keeper({ promote: () => jsonResponse({ error: 'forbidden' }, 403) }),
      reason: 'This keeper refused the merge (403).',
    },
  ])('reports $name as a failed result with its reason', async ({ fetch, reason }) => {
    expect(await accept(fetch())).toEqual({ ok: false, reason })
  })

  it.each([
    {
      name: 'an ok answer that fails the promote schema',
      promote: () => jsonResponse({ ok: true, attested: 'yes' }),
      path: 'attested',
    },
    {
      name: 'an ok answer that is not JSON',
      promote: () => new Response('merged', { status: 200 }),
      path: '(root)',
    },
  ])('reports $name as an unexpected response and logs where it disagreed', async ({
    promote,
    path,
  }) => {
    expect(await accept(keeper({ promote }))).toEqual({
      ok: false,
      reason: 'This keeper answered the merge with an unexpected response.',
    })
    await expectLoggedFailure(`/workspace-document/promote failed its contract at ${path}`)
  })

  it('refuses a snapshot that does not decode without asking the keeper anything', async () => {
    const fetch = keeper({ promote: promoted })
    expect(await accept(fetch, GARBAGE)).toEqual({
      ok: false,
      reason: 'That does not look like a workspace record.',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('acceptTransferredRecord on a landed merge', () => {
  it('reports the arriving record ids and the paths the keeper lists as shadowed', async () => {
    const fetch = keeper({
      promote: promoted,
      list: () =>
        jsonResponse({
          documents: [
            {
              path: 'notes/roadmap',
              id: DOCUMENT_ID,
              kind: 'markdown',
              updatedAt: 't',
              shadowed: true,
            },
            { path: 'notes/other', id: 'other', kind: 'markdown', updatedAt: 't' },
          ],
        }),
    })
    expect(await accept(fetch)).toMatchObject({
      ok: true,
      promotedDocumentIds: [DOCUMENT_ID],
      shadowedPaths: ['notes/roadmap'],
      attested: false,
    })
  })

  it('degrades a failed read-back to none reported, never to a failed merge', async () => {
    const fetch = keeper({
      promote: promoted,
      list: () => jsonResponse({ error: 'unauthorized' }, 401),
    })
    expect(await accept(fetch)).toMatchObject({ ok: true, shadowedPaths: [] })
  })
})
