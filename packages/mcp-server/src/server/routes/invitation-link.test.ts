/**
 * ADR-0049 decision 3: an invitation travels as a link to this keeper's
 * `/invite` page, its token in the fragment a browser never sends onward.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createInvitationStore } from '../security/invitation-store.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { issueInvitationLink } from './invitation-link.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-invitation-link-'))
  handle = await createIsolatedDb({ dataDir: root })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

it('links to the invite page with the token in the fragment, and the token opens the invitation', async () => {
  const invitations = createInvitationStore(handle.db)
  const link = await issueInvitationLink(invitations, 'https://wb.test', {
    invitedBy: 'u-ada',
    workspaceId: 'ws-1',
  })
  const url = new URL(link.url)
  expect(`${url.origin}${url.pathname}${url.search}`).toBe('https://wb.test/invite')
  const token = new URLSearchParams(url.hash.slice(1)).get('token') ?? ''
  expect(await invitations.openLink(token, Date.now())).toMatchObject({
    ok: true,
    invitation: { workspaceId: 'ws-1', invitedBy: 'u-ada' },
  })
  expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now())
})
