// What `DatabaseSchema` claims about each column's storage class and
// nullability, written out so `schema-conformance.test.ts` can compare it with
// the migrated database.
//
// It is a plain module rather than part of that test because this package's
// typecheck excludes `*.test.ts`, and the ledger's value is that tsc refuses it
// when it omits a column, names one the schema lacks, or disagrees with the
// schema about nullability or storage class. Production never imports it.

import type { Selectable } from 'kysely'
import type { DatabaseSchema } from './schema.js'

type SqlTypeOf<V> =
  NonNullable<V> extends number
    ? 'INTEGER'
    : NonNullable<V> extends Uint8Array
      ? 'BLOB'
      : NonNullable<V> extends string
        ? 'TEXT'
        : never

// What the schema's TypeScript type for a column forces the ledger to say.
interface ColumnClaim<V> {
  readonly type: SqlTypeOf<V>
  readonly nullable: null extends V ? true : false
}

type Ledger = {
  [T in keyof DatabaseSchema]: {
    [C in keyof Selectable<DatabaseSchema[T]>]: ColumnClaim<Selectable<DatabaseSchema[T]>[C]>
  }
}

const text = { type: 'TEXT', nullable: false } as const
const textOrNull = { type: 'TEXT', nullable: true } as const
const integer = { type: 'INTEGER', nullable: false } as const
const integerOrNull = { type: 'INTEGER', nullable: true } as const
const blob = { type: 'BLOB', nullable: false } as const

export const LEDGER: Ledger = {
  workspaces: {
    id: text,
    displayName: textOrNull,
    segment: textOrNull,
    createdAt: integer,
    updatedAt: integer,
    replicaTier: textOrNull,
  },
  versions: {
    id: text,
    documentId: text,
    workspaceId: text,
    branchName: text,
    auto: integer,
    label: textOrNull,
    operatorKind: text,
    operatorActor: text,
    operatorDisplayName: textOrNull,
    operatorAgentId: textOrNull,
    operatorWorkspaceId: textOrNull,
    elementCount: integer,
    frontiers: text,
    contentDigest: text,
    createdAt: integer,
    restoredFrom: textOrNull,
    attestation: textOrNull,
  },
  runtime: { key: text, value: textOrNull, updatedAt: integer },
  documentSnapshots: {
    docKey: text,
    chunkCount: integer,
    totalBytes: integer,
    maxChunkBytes: integer,
    frontier: blob,
    generation: integer,
  },
  documentSnapshotChunks: { docKey: text, chunkIndex: integer, bytes: blob },
  documentDeltas: { docKey: text, seq: integer, bytes: blob, frontier: blob },
  documentFrontiers: { docKey: text, frontier: blob },
  leases: { name: text, holder: text, expiresAt: integer },
  memberProfiles: {
    id: text,
    displayName: text,
    accountId: text,
    createdAt: integer,
    updatedAt: integer,
    deactivatedAt: integerOrNull,
  },
  accounts: { id: text, createdAt: integer },
  accountBindings: { authenticator: text, subject: text, accountId: text, createdAt: integer },
  invitations: {
    id: text,
    tokenHash: textOrNull,
    email: textOrNull,
    invitedBy: text,
    createdAt: integer,
    expiresAt: integer,
    redeemedAt: integerOrNull,
    redeemedBy: textOrNull,
    workspaceId: textOrNull,
  },
  signInSessions: {
    tokenHash: text,
    authenticator: text,
    subject: text,
    createdAt: integer,
    expiresAt: integer,
    authenticatedAt: integerOrNull,
  },
  signInAttempts: {
    state: text,
    browserBindingHash: text,
    providerId: text,
    nonce: text,
    codeVerifier: text,
    invitationToken: textOrNull,
    returnTo: text,
    expiresAt: integer,
  },
  workspaceMemberships: { workspaceId: text, profileId: text, createdAt: integer, role: text },
  tenantAdministrators: { profileId: text, appointedBy: textOrNull, appointedAt: integer },
  workspaceReplicaKeys: { workspaceId: text, key: blob, salt: blob, createdAt: integer },
  workspaceMembersOnly: { workspaceId: text, since: integer },
  tenants: { id: text, createdAt: integer },
}

// Columns the schema declares NOT NULL that the migrations created nullable.
// Each is a deliberate gap with a stated reason, and each is checked from the
// other side: an entry whose column has since become NOT NULL fails, so the
// list cannot outlive the debt.
export const NULLABLE_IN_DATABASE: {
  [T in keyof DatabaseSchema]?: { [C in keyof Selectable<DatabaseSchema[T]>]?: string }
} = {
  memberProfiles: {
    accountId:
      'migration 0032 added it nullable (SQLite ADD COLUMN takes no NOT NULL without a default); every insert carries one. ponytail: rebuild the table if a NULL ever turns up.',
  },
  workspaceMemberships: {
    role: 'migration 0036 added it nullable for the same reason; every insert carries one. ponytail: rebuild the table if a NULL ever turns up.',
  },
}
