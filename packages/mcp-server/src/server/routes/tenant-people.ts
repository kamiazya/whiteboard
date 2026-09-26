/**
 * ADR-0049 decisions 1, 2 and 4 on server mode: what a tenant's
 * administrators do to its people — see every user, deactivate and
 * reactivate them, appoint and dismiss administrators, and invite to the
 * tenant alone. An administrator is not thereby an owner: nothing here reads
 * or changes a workspace. Every route answers only an administrator, and the
 * check is the person's role, not the credential's scope.
 */
import {
  administratorResponseSchema,
  deactivationResponseSchema,
  type TenantPeopleRefusal,
  tenantPeopleResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/tenant-people'
import { type Context, Hono } from 'hono'
import { getLogger } from '../log.js'
import type { AdministratorCheck } from '../security/administrator-check.js'
import type { InvitationStore } from '../security/invitation-store.js'
import type { MemberProfileStore } from '../security/member-profile-store.js'
import { callerPerson, callerUserId } from '../security/membership-gate.js'
import type { TenantAdministratorStore } from '../security/tenant-administrator-store.js'
import type { UserDeactivation } from '../security/user-deactivation.js'
import { issueInvitationLink } from './invitation-link.js'

const log = getLogger('tenant-people')

interface TenantPeopleRouterOptions {
  readonly members: MemberProfileStore
  readonly invitations: InvitationStore
  readonly administration: {
    readonly check: AdministratorCheck
    readonly appointments: TenantAdministratorStore
    readonly deactivation: UserDeactivation
  }
  /** This host's origin, where the web app's invite page is. */
  readonly origin: string
}

const REFUSALS = {
  not_an_administrator: [403, 'only an administrator of this server can do that'],
  unknown_user: [404, 'no user by that id here'],
  cannot_deactivate_self: [409, 'an administrator cannot deactivate themselves'],
} as const satisfies Record<TenantPeopleRefusal['error'], readonly [number, string]>

function refuse(c: Context, error: TenantPeopleRefusal['error']) {
  const [status, message] = REFUSALS[error]
  log.warning({ path: c.req.path, reason: error }, 'tenant people change refused')
  return c.json({ error, message } satisfies TenantPeopleRefusal, status)
}

// The acting administrator's own user id, or null when the caller is not one.
async function administrator(c: Context, options: TenantPeopleRouterOptions) {
  const person = callerPerson(c)
  if (person === undefined || !(await options.administration.check.isAdministrator(person))) {
    return null
  }
  return callerUserId(c, options.members)
}

async function isUser(members: MemberProfileStore, userId: string) {
  return (await members.listUsers()).some((u) => u.id === userId)
}

function mountDeactivation(app: Hono, options: TenantPeopleRouterOptions): void {
  const { members, administration } = options
  app.post('/api/people/:userId/deactivation', async (c) => {
    const acting = await administrator(c, options)
    if (acting === null) return refuse(c, 'not_an_administrator')
    const userId = c.req.param('userId')
    if (!(await isUser(members, userId))) return refuse(c, 'unknown_user')
    if (userId === acting) return refuse(c, 'cannot_deactivate_self')
    await administration.deactivation.deactivate(userId, Date.now())
    log.notice({ userId, by: acting }, 'user deactivated')
    return c.json(deactivationResponseSchema.parse({ userId, deactivated: true }), 200)
  })
  app.delete('/api/people/:userId/deactivation', async (c) => {
    const acting = await administrator(c, options)
    if (acting === null) return refuse(c, 'not_an_administrator')
    const userId = c.req.param('userId')
    if (!(await isUser(members, userId))) return refuse(c, 'unknown_user')
    await administration.deactivation.reactivate(userId)
    log.notice({ userId, by: acting }, 'user reactivated')
    return c.json(deactivationResponseSchema.parse({ userId, deactivated: false }), 200)
  })
}

function mountAppointments(app: Hono, options: TenantPeopleRouterOptions): void {
  const { members, administration } = options
  app.put('/api/people/:userId/administrator', async (c) => {
    const acting = await administrator(c, options)
    if (acting === null) return refuse(c, 'not_an_administrator')
    const userId = c.req.param('userId')
    if (!(await isUser(members, userId))) return refuse(c, 'unknown_user')
    await administration.appointments.appoint(userId, acting)
    log.notice({ userId, by: acting }, 'administrator appointed')
    return c.json(administratorResponseSchema.parse({ userId, administrator: true }), 200)
  })
  app.delete('/api/people/:userId/administrator', async (c) => {
    const acting = await administrator(c, options)
    if (acting === null) return refuse(c, 'not_an_administrator')
    const userId = c.req.param('userId')
    if (!(await isUser(members, userId))) return refuse(c, 'unknown_user')
    await administration.appointments.dismiss(userId)
    log.notice({ userId, by: acting }, 'administrator dismissed')
    return c.json(administratorResponseSchema.parse({ userId, administrator: false }), 200)
  })
}

export function createTenantPeopleRouter(options: TenantPeopleRouterOptions) {
  const app = new Hono()

  app.get('/api/people', async (c) => {
    if ((await administrator(c, options)) === null) return refuse(c, 'not_an_administrator')
    const administrators = await options.administration.check.administratorIds()
    const people = (await options.members.listUsers()).map((user) => ({
      userId: user.id,
      displayName: user.displayName,
      deactivated: user.deactivated,
      administrator: administrators.has(user.id),
    }))
    return c.json(tenantPeopleResponseSchema.parse({ people }), 200)
  })

  mountDeactivation(app, options)
  mountAppointments(app, options)

  // ADR-0049 decision 3: an administrator's invitation names no workspace.
  app.post('/api/invitations', async (c) => {
    const invitedBy = await administrator(c, options)
    if (invitedBy === null) return refuse(c, 'not_an_administrator')
    return c.json(
      await issueInvitationLink(options.invitations, options.origin, { invitedBy }),
      201,
    )
  })

  return app
}
