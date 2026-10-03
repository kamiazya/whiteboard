/**
 * ADR-0049 decision 3: an invitation travels as a link to this keeper's
 * `/invite` page, its token in the fragment a browser never sends onward.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  vi.useRealTimers()
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

// The lifetime is not a parameter of the route, so the shipped default is the
// only thing that says how long a link someone forwarded stays good for.
it('stays good for seven days and not a moment longer', async () => {
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
  const issuedAt = Date.parse('2030-01-01T00:00:00Z')
  vi.useFakeTimers({ toFake: ['Date'], now: issuedAt })
  const invitations = createInvitationStore(handle.db)
  const link = await issueInvitationLink(invitations, 'https://wb.test', { invitedBy: 'u-ada' })
  const token = new URLSearchParams(new URL(link.url).hash.slice(1)).get('token') ?? ''

  expect(link.expiresAt).toBe(new Date(issuedAt + SEVEN_DAYS).toISOString())
  expect(await invitations.openLink(token, issuedAt + SEVEN_DAYS - 1)).toMatchObject({ ok: true })
  expect(await invitations.openLink(token, issuedAt + SEVEN_DAYS)).toEqual({
    ok: false,
    reason: 'expired',
  })
})
