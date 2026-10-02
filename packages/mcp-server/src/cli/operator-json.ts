// The `--json` stdout of the operator commands, one declaration each.
// docs/how-to/self-host-with-docker.md advertises these for scripting, so a
// script reads a versioned shape rather than whatever a handler happened to
// build. Every output is one JSON line, parsed through its schema on the way
// out: a field a handler forgets or adds is a crash in the command, not a
// silent change in what an operator's script receives.
//
// `kind` names the outcome and `schemaVersion` the shape. Bump the version when
// an arm loses or renames a field; adding an arm or an optional field is not a
// break for a reader that switches on `kind`.
import { z } from 'zod'
import { manifestDirSchema } from '../daemon/native-host/install.js'

export const OPERATOR_JSON_SCHEMA_VERSION = 1 as const
const schemaVersion = z.literal(OPERATOR_JSON_SCHEMA_VERSION)

const namedUserSchema = z.object({ id: z.string(), displayName: z.string() }).strict()
export type NamedUser = z.infer<typeof namedUserSchema>

/** The refusals every user-naming command shares: the candidates ride along. */
const unknownUserSchema = z
  .object({
    schemaVersion,
    kind: z.enum(['unknown-user', 'ambiguous-user']),
    users: z.array(namedUserSchema),
  })
  .strict()

export const addUserOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      schemaVersion,
      kind: z.literal('ok'),
      created: z.boolean(),
      user: namedUserSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion,
      kind: z.literal('unknown-provider'),
      providers: z.array(z.string()),
    })
    .strict(),
])

export const grantAdminOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      schemaVersion,
      kind: z.literal('ok'),
      user: namedUserSchema,
      administrator: z.boolean(),
    })
    .strict(),
  unknownUserSchema,
])
export type GrantAdminOutput = z.infer<typeof grantAdminOutputSchema>

export const grantMemberOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      schemaVersion,
      kind: z.literal('ok'),
      workspaceId: z.string(),
      user: namedUserSchema,
    })
    .strict(),
  z
    .object({ schemaVersion, kind: z.literal('unknown-workspace'), workspaceId: z.string() })
    .strict(),
  unknownUserSchema,
])
export type GrantMemberOutput = z.infer<typeof grantMemberOutputSchema>

export const deactivateUserOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      schemaVersion,
      kind: z.literal('ok'),
      user: namedUserSchema,
      deactivated: z.boolean(),
      changed: z.boolean(),
    })
    .strict(),
  unknownUserSchema,
])
export type DeactivateUserOutput = z.infer<typeof deactivateUserOutputSchema>

export const nativeHostInstallOutputSchema = z
  .object({
    schemaVersion,
    ok: z.boolean(),
    reason: z.string().optional(),
    launcher: z.string(),
    manifests: z.array(manifestDirSchema),
  })
  .strict()

export const serverRestoreOutputSchema = z
  .object({ schemaVersion, ok: z.literal(true), operation: z.literal('restore') })
  .strict()

export const serverRunDryRunOutputSchema = z
  .object({
    schemaVersion,
    ok: z.literal(true),
    dryRun: z.literal(true),
    publicBaseUrl: z.string(),
    allowedOrigins: z.array(z.string()),
    authStrategy: z.literal('oauth-jwt'),
  })
  .strict()

export const serverRunReadyOutputSchema = z
  .object({
    schemaVersion,
    ok: z.literal(true),
    pid: z.number().int(),
    host: z.string(),
    port: z.number().int(),
    publicBaseUrl: z.string(),
    authStrategy: z.literal('oauth-jwt'),
    startedAt: z.string(),
  })
  .strict()

// Names the files written, never where: the server bundle's stdout is pasted
// into support threads, and a path in it is an operator's layout.
export const serverSupportBundleOutputSchema = z
  .object({
    schemaVersion,
    ok: z.literal(true),
    operation: z.literal('support-bundle'),
    files: z.array(z.string()),
  })
  .strict()

export const daemonSupportBundleOutputSchema = z
  .object({
    schemaVersion,
    ok: z.literal(true),
    outputDir: z.string(),
    files: z.array(z.string()),
  })
  .strict()

/** What a command computes before it stamps the version on. */
export type WithoutSchemaVersion<T> = T extends unknown ? Omit<T, 'schemaVersion'> : never

/** The output as the one line a command writes to stdout. */
export function operatorJsonLine<S extends z.ZodType>(schema: S, output: z.input<S>): string {
  return `${JSON.stringify(schema.parse(output))}\n`
}
