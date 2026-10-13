/**
 * The refusal codes a people route can answer are an enum in the keeper's
 * own contract. This drives every member through the client rather than
 * the two it happens to act on, so a code added to the contract reaches the
 * page as its sentence, and the one that asks for a fresh sign-in is the
 * only one that says so.
 */
import {
  tenantPersonAdministratorApiUrl,
  tenantPersonDeactivationApiUrl,
  workspacePersonApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { tenantPeopleRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/tenant-people'
import { workspacePeopleRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import { describe, expect, it } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { tenantPeople, workspacePeople } from './server-people.js'

const refusing =
  (body: unknown, status = 403): typeof globalThis.fetch =>
  async () =>
    jsonResponse(body, status)

describe('server-people refusals', () => {
  it.each(
    tenantPeopleRefusalSchema.shape.error.options,
  )("carries the keeper's sentence for a tenant refusal: %s", async (error) => {
    const outcome = await tenantPeople.list(refusing({ error, message: `because ${error}` }))
    expect(outcome).toMatchObject({ ok: false, message: `because ${error}` })
    expect('reauthenticate' in outcome).toBe(error === 'reauthentication_required')
  })

  it.each(
    workspacePeopleRefusalSchema.shape.error.options,
  )("carries the keeper's sentence for a workspace refusal: %s", async (error) => {
    const outcome = await workspacePeople.list(
      refusing({ error, message: `because ${error}` }),
      'ws-1',
    )
    expect(outcome).toEqual({ ok: false, message: `because ${error}` })
  })

  it('names the workspaces a sole owner still holds (ADR-0051)', async () => {
    const outcome = await tenantPeople.delete(
      refusing({ error: 'sole_owner', message: 'still the only owner', workspaceIds: ['a', 'b'] }),
      'user-1',
    )
    expect(outcome).toEqual({ ok: false, message: 'still the only owner: a, b' })
  })

  it('carries the sentence of a refusal code a newer keeper added, with a field this page has not heard of', async () => {
    const outcome = await tenantPeople.list(
      refusing({ error: 'rate_limited', message: 'slow down', retryAfter: 3 }, 429),
    )
    expect(outcome).toEqual({ ok: false, message: 'slow down' })
  })

  it('answers a body neither contract admits with a plain refusal, never a crash', async () => {
    const outcome = await tenantPeople.list(refusing({ error: 'unauthorized' }, 401))
    expect(outcome).toEqual({ ok: false, message: 'That was refused.' })
    const html = await tenantPeople.list(async () => new Response('<html/>', { status: 502 }))
    expect(html).toEqual({ ok: false, message: 'That was refused.' })
  })
})

/** A keeper that answers every call with `body`, remembering what was asked. */
function answering(body: unknown) {
  const calls: { url: string; method: string }[] = []
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' })
    return jsonResponse(body, 200)
  }
  return { calls, fetchFn }
}

describe('server-people calls', () => {
  it.each([
    [true, 'POST'],
    [false, 'DELETE'],
  ] as const)('sets deactivated=%s with %s on the deactivation route', async (deactivated, method) => {
    const keeper = answering({ userId: 'user-1', deactivated })
    const outcome = await tenantPeople.setDeactivated(keeper.fetchFn, 'user-1', deactivated)
    expect(keeper.calls).toEqual([{ url: tenantPersonDeactivationApiUrl('user-1'), method }])
    expect(outcome).toEqual({ ok: true, value: { userId: 'user-1', deactivated } })
  })

  it.each([
    [true, 'PUT'],
    [false, 'DELETE'],
  ] as const)('sets administrator=%s with %s on the administrator route', async (administrator, method) => {
    const keeper = answering({ userId: 'user-1', administrator })
    const outcome = await tenantPeople.setAdministrator(keeper.fetchFn, 'user-1', administrator)
    expect(keeper.calls).toEqual([{ url: tenantPersonAdministratorApiUrl('user-1'), method }])
    expect(outcome).toEqual({ ok: true, value: { userId: 'user-1', administrator } })
  })

  it("removes a workspace's person with DELETE on that person's route", async () => {
    const keeper = answering({ removed: true })
    const outcome = await workspacePeople.remove(keeper.fetchFn, 'ws-1', 'user-1')
    expect(keeper.calls).toEqual([
      { url: workspacePersonApiUrl('ws-1', 'user-1'), method: 'DELETE' },
    ])
    expect(outcome).toEqual({ ok: true, value: { removed: true } })
  })

  it('answers a success body its contract does not admit as unexpected, never as the value', async () => {
    const keeper = answering({ userId: 'user-1', administrator: 'yes' })
    const outcome = await tenantPeople.setAdministrator(keeper.fetchFn, 'user-1', true)
    expect(outcome).toEqual({
      ok: false,
      message: 'The server answered in a way this page does not understand.',
    })
    await expectLoggedFailure('/administrator failed its contract at administrator')
  })

  it('answers a success body cut mid-stream as the server not reached', async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"userId":'))
        controller.error(new TypeError('network error'))
      },
    })
    const outcome = await tenantPeople.setAdministrator(
      async () => new Response(cut, { status: 200 }),
      'user-1',
      true,
    )
    expect(outcome).toEqual({ ok: false, message: 'Could not reach the server. Try again.' })
  })
})
