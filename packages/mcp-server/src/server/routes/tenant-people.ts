/**
 * ADR-0049 decisions 1, 2 and 4 on server mode: what a tenant's
 * administrators do to its people — see every user, deactivate, reactivate
 * and delete them (ADR-0051), appoint and dismiss administrators, and invite
 * to the tenant alone. An administrator is not thereby an owner: nothing here reads
 * or changes a workspace. Every route answers only an administrator, and the
 * check is the person's role, not the credential's scope.
 *
 * The decisions are `security/people-administration.ts`'s, which the
 * operator's command line shares; this translates the request into them and
 * their refusals into status codes.
 */
import {
  administratorResponseSchema,
  deactivationResponseSchema,
  deletionResponseSchema,
  type TenantPeopleRefusal,
  tenantPeopleResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/tenant-people'
import { type Context, Hono } from 'hono'
import { getLogger } from '../log.js'
import type { InvitationStore } from '../security/invitation-store.js'
import { callerGrant } from '../security/membership-gate.js'
import {
  type AdministrationAccess,
  type AnyRefusal,
  createAdministrationAccess,
  createPeopleAdministration,
  deletePerson,
  type PeopleAdministration,
  type PeopleAdministrationWiring,
} from '../security/people-administration.js'
import { endSyncStreamsOf } from '../sync-streams.js'
import { issueInvitationLink } from './invitation-link.js'

const log = getLogger('tenant-people')

interface TenantPeopleRouterOptions extends PeopleAdministrationWiring {
  readonly invitations: InvitationStore
  /** This host's origin, where the web app's invite page is. */
  readonly origin: string
  readonly now?: () => number
}

interface Administration {
  readonly access: AdministrationAccess
  readonly people: PeopleAdministration
  readonly options: TenantPeopleRouterOptions
}

const REFUSALS = {
  not_an_administrator: [403, 'only an administrator of this server can do that'],
  unknown_user: [404, 'no user by that id here'],
  cannot_deactivate_self: [409, 'an administrator cannot deactivate themselves'],
  cannot_dismiss_self: [409, 'an administrator cannot dismiss themselves; another one can'],
  not_deactivated: [409, 'deactivate a person before deleting them'],
  sole_owner: [409, 'they are the only owner of these workspaces; appoint another owner first'],
  sign_in_required: [403, 'administering this server needs a browser sign-in, not a bearer'],
  reauthentication_required: [403, 'sign in again to confirm it is you, then retry'],
} as const satisfies Record<TenantPeopleRefusal['error'], readonly [number, string]>

function refuse(c: Context, refusal: AnyRefusal & { readonly workspaceIds?: readonly string[] }) {
  const { reason: error, workspaceIds } = refusal
  const [status, message] = REFUSALS[error]
  log.warning({ path: c.req.path, reason: error }, 'tenant people change refused')
  const detail = workspaceIds === undefined ? {} : { workspaceIds: [...workspaceIds] }
  return c.json({ error, message, ...detail } satisfies TenantPeopleRefusal, status)
}

// The acting administrator's user id for an ACTION, or the refusal to send.
async function administering(c: Context, { access, options }: Administration) {
  const authorization = await access.authorize(callerGrant(c), (options.now ?? Date.now)())
  return authorization.kind === 'authorized' ? authorization.userId : refuse(c, authorization)
}

function mountDeactivation(app: Hono, admin: Administration): void {
  app.post('/api/people/:userId/deactivation', async (c) => {
    const acting = await administering(c, admin)
    if (acting instanceof Response) return acting
    const userId = c.req.param('userId')
    const outcome = await admin.people.deactivate(userId, acting, Date.now())
    if (outcome.kind === 'refused') return refuse(c, outcome)
    endSyncStreamsOf(userId)
    log.notice({ userId, by: acting }, 'user deactivated')
    return c.json(deactivationResponseSchema.parse({ userId, deactivated: true }), 200)
  })
  app.delete('/api/people/:userId/deactivation', async (c) => {
    const acting = await administering(c, admin)
    if (acting instanceof Response) return acting
    const userId = c.req.param('userId')
    const outcome = await admin.people.reactivate(userId)
    if (outcome.kind === 'refused') return refuse(c, outcome)
    log.notice({ userId, by: acting }, 'user reactivated')
    return c.json(deactivationResponseSchema.parse({ userId, deactivated: false }), 200)
  })
}

function mountDeletion(app: Hono, admin: Administration): void {
  app.delete('/api/people/:userId', async (c) => {
    const acting = await administering(c, admin)
    if (acting instanceof Response) return acting
    const userId = c.req.param('userId')
    const outcome = await deletePerson(admin.options.administration.deletion, userId)
    if (outcome.kind === 'refused') return refuse(c, outcome)
    log.notice({ userId, by: acting }, 'user deleted')
    return c.json(deletionResponseSchema.parse({ userId, deleted: true }), 200)
  })
}

function mountAppointments(app: Hono, admin: Administration): void {
  app.put('/api/people/:userId/administrator', async (c) => {
    const acting = await administering(c, admin)
    if (acting instanceof Response) return acting
    const userId = c.req.param('userId')
    const outcome = await admin.people.appoint(userId, acting)
    if (outcome.kind === 'refused') return refuse(c, outcome)
    log.notice({ userId, by: acting }, 'administrator appointed')
    return c.json(administratorResponseSchema.parse({ userId, administrator: true }), 200)
  })
  app.delete('/api/people/:userId/administrator', async (c) => {
    const acting = await administering(c, admin)
    if (acting instanceof Response) return acting
    const userId = c.req.param('userId')
    const outcome = await admin.people.dismiss(userId, acting)
    if (outcome.kind === 'refused') return refuse(c, outcome)
    log.notice({ userId, by: acting }, 'administrator dismissed')
    return c.json(administratorResponseSchema.parse({ userId, administrator: false }), 200)
  })
}

export function createTenantPeopleRouter(options: TenantPeopleRouterOptions) {
  const app = new Hono()
  const { members, administration } = options
  const admin: Administration = {
    access: createAdministrationAccess({ members, check: administration.check }),
    people: createPeopleAdministration({
      members,
      appointments: administration.appointments,
      deactivation: administration.deactivation,
    }),
    options,
  }

  // Listing people is not an action, so it asks for an administrator and no more.
  app.get('/api/people', async (c) => {
    if ((await admin.access.administratorOf(callerGrant(c))) === null) {
      return refuse(c, { kind: 'refused', reason: 'not_an_administrator' })
    }
    return c.json(
      tenantPeopleResponseSchema.parse({ people: await admin.access.listPeople() }),
      200,
    )
  })

  mountDeactivation(app, admin)
  mountDeletion(app, admin)
  mountAppointments(app, admin)

  // ADR-0049 decision 3: an administrator's invitation names no workspace.
  app.post('/api/invitations', async (c) => {
    const invitedBy = await administering(c, admin)
    if (invitedBy instanceof Response) return invitedBy
    return c.json(
      await issueInvitationLink(options.invitations, options.origin, { invitedBy }),
      201,
    )
  })

  return app
}
