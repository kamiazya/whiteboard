import { z } from 'zod'

/**
 * ADR-0049 decisions 1, 2 and 4: a tenant's people as its administrators
 * manage them on server mode — every user, whether they are deactivated,
 * and whether they administer. Only an administrator reads or changes this.
 * Deliberately free of any node:* import — the browser consumes these
 * schemas directly.
 */

export const tenantPersonSchema = z
  .object({
    userId: z.string().min(1),
    displayName: z.string().min(1),
    deactivated: z.boolean(),
    // Appointed in the product or named in configuration; the list does not
    // say which, since only an appointment can be dismissed here.
    administrator: z.boolean(),
  })
  .strict()

export const tenantPeopleResponseSchema = z.object({ people: z.array(tenantPersonSchema) }).strict()

export const deactivationResponseSchema = z
  .object({ userId: z.string().min(1), deactivated: z.boolean() })
  .strict()

export const administratorResponseSchema = z
  .object({ userId: z.string().min(1), administrator: z.boolean() })
  .strict()

/** Why an administrator's change was refused. A narrowing of `apiErrorBodySchema`. */
export const tenantPeopleRefusalSchema = z
  .object({
    error: z.enum([
      'not_an_administrator',
      'unknown_user',
      'cannot_deactivate_self',
      'cannot_dismiss_self',
    ]),
    message: z.string().min(1),
  })
  .strict()

export type TenantPeopleRefusal = z.infer<typeof tenantPeopleRefusalSchema>
