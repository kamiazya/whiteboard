/**
 * The refusal codes a people route can answer are an enum in the keeper's
 * own contract. This drives every member through the client rather than
 * the two it happens to act on, so a code added to the contract reaches the
 * page as its sentence, and the one that asks for a fresh sign-in is the
 * only one that says so.
 */
import { tenantPeopleRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/tenant-people'
import { workspacePeopleRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import { describe, expect, it } from 'vitest'
import { tenantPeople, workspacePeople } from './server-people.js'

const refusing =
  (body: unknown, status = 403): typeof globalThis.fetch =>
  async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

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

  it('answers a body neither contract admits with a plain refusal, never a crash', async () => {
    const outcome = await tenantPeople.list(refusing({ error: 'unauthorized' }, 401))
    expect(outcome).toEqual({ ok: false, message: 'That was refused.' })
    const html = await tenantPeople.list(async () => new Response('<html/>', { status: 502 }))
    expect(html).toEqual({ ok: false, message: 'That was refused.' })
  })
})
