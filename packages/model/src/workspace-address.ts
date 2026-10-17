import { z } from 'zod'
import { deriveWorkspaceSegment } from './derive-workspace-segment.js'
import { workspaceCanonicalIdSchema, workspaceIdSchema, workspaceSegmentSchema } from './ids.js'

/**
 * The namespace a single-person keeper (the browser, the local daemon) holds
 * every workspace in (ADR-0053 decision 2). One fixed spelling, so the one URL
 * grammar reads the same on every keeper.
 */
export const SINGLE_PERSON_NAMESPACE = 'me'

/**
 * The handle an ADDRESS may name a namespace by: the segment grammar, never
 * ULID-shaped (that refinement is `workspaceSegmentSchema`'s). Never
 * ULID-shaped is what lets `/w/<ULID>` and `/w/<handle>/<segment>` share the
 * first position without ambiguity. It admits `me`, because a single-person
 * keeper's addresses spell their namespace that way.
 */
export const namespaceHandleSchema = workspaceSegmentSchema

/**
 * A handle a USER may hold. The address grammar minus `me`, which is reserved
 * so that on a keeper with many people `/w/me/…` names nobody's namespace, and
 * a link carrying it cannot mean a different workspace to each person who
 * opens it. Refused in every casing, because the segment grammar admits
 * capitals and a reader takes `ME` for `me`.
 *
 * Uniqueness per `(tenantId, handle)` is the registry's to enforce, as a
 * segment's is: what makes a handle unavailable is another row holding it.
 */
export const userHandleSchema = namespaceHandleSchema.refine(
  (handle) => handle.toLowerCase() !== SINGLE_PERSON_NAMESPACE,
  `"${SINGLE_PERSON_NAMESPACE}" is reserved for a single-person keeper's namespace`,
)

/**
 * What a handle derives from when its user's display name spells none: a
 * script the segment charset cannot write, a name past the length bound, or
 * a name that would land on `me`.
 */
const FALLBACK_USER_HANDLE = 'user'

/**
 * The handle a user who has not chosen one starts from, derived from their
 * display name. Total, unlike `deriveWorkspaceSegment`: a workspace without a
 * segment is still reached by its canonical id, but a person without a handle
 * has no in-app address at all.
 *
 * The answer is a BASE, not a reservation. The registry makes it unique with
 * `firstFreeSegment`, which re-checks only the segment grammar — enough here,
 * because every suffix carries a hyphen and neither `me` nor a ULID can.
 */
export function deriveUserHandle(displayName: string): string {
  const derived = deriveWorkspaceSegment(displayName)
  return derived !== undefined && userHandleSchema.safeParse(derived).success
    ? derived
    : FALLBACK_USER_HANDLE
}

/**
 * A one-component address that is not a canonical id: a segment in the
 * caller's own namespace, or a legacy daemon id (`default`, nanoid strings
 * carrying `_`), which resolution still has to reach.
 */
const bareHandleSchema = workspaceIdSchema.refine(
  (handle) => !workspaceCanonicalIdSchema.safeParse(handle).success,
  'a canonical ULID is the id form, not a bare handle',
)

/**
 * The three forms a workspace address takes (ADR-0053): the canonical id, a
 * segment qualified by the namespace that holds it, and a bare segment that
 * means the CALLER's own namespace. Parsing decides only the form; which
 * workspace it names is the registry's answer (`resolveWorkspaceHandle`).
 */
export const workspaceAddressSchema = z.discriminatedUnion('form', [
  z.object({ form: z.literal('id'), workspaceId: workspaceCanonicalIdSchema }).strict(),
  z
    .object({
      form: z.literal('qualified'),
      namespace: namespaceHandleSchema,
      segment: workspaceSegmentSchema,
    })
    .strict(),
  z.object({ form: z.literal('bare'), handle: bareHandleSchema }).strict(),
])
export type WorkspaceAddress = z.infer<typeof workspaceAddressSchema>

/**
 * An address as a caller TYPES it, before `parseWorkspaceAddress` decides its
 * form: one handle, or a namespace handle and a segment joined by one `/`. A
 * pattern rather than a refinement, so a published JSON Schema states the
 * grammar too; which workspace it names stays the registry's answer. `\w` is
 * `WORKSPACE_ID_PATTERN`'s `[a-zA-Z0-9_]` exactly (no `u` flag), spelled
 * short because every tool's schema publishes it.
 */
const WORKSPACE_ADDRESS_PATTERN = /^[\w-]+(\/[\w-]+)?$/

export const workspaceAddressInputSchema = z
  .string()
  .regex(
    WORKSPACE_ADDRESS_PATTERN,
    'a workspace address is an id, <handle>/<segment>, or a segment ([a-zA-Z0-9_-], at most one "/")',
  )

/** The address an input string spells, or null when it spells none of the three forms. */
export function parseWorkspaceAddress(input: string): WorkspaceAddress | null {
  const parts = input.split('/')
  const candidate =
    parts.length === 2
      ? { form: 'qualified', namespace: parts[0], segment: parts[1] }
      : workspaceCanonicalIdSchema.safeParse(input).success
        ? { form: 'id', workspaceId: input }
        : { form: 'bare', handle: input }
  const parsed = workspaceAddressSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/** The string `parseWorkspaceAddress` reads back as `address`. */
export function formatWorkspaceAddress(address: WorkspaceAddress): string {
  switch (address.form) {
    case 'id':
      return address.workspaceId
    case 'qualified':
      return `${address.namespace}/${address.segment}`
    case 'bare':
      return address.handle
  }
}
