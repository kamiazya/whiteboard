/**
 * The read plane's per-workspace content key (ADR-0042 decisions 1/3/5,
 * ADR-0043 decision 3): a random 32-byte AES key plus a 16-byte HKDF salt,
 * minted lazily on first read and never rotated by this store — a rotation
 * is a (not yet built) explicit route, not a side effect of a read. The
 * browser derives each document's own key from this one via daemon-client's
 * `deriveDocumentKey`, folding in that document's own epoch (which lives
 * beside its ciphertext, not here).
 *
 * The key is a daemon-held secret AT REST, not a secret from the daemon
 * itself — this store never claims otherwise. The data directory is
 * owner-only (see `secret-file-mode.ts`'s sibling posture for the JSON
 * secrets), and a filesystem backup of `whiteboard.db` already carries every
 * document's plaintext, so this row adds no new secret-surface class beyond
 * what a backup of the database already exposes.
 */
import { randomBytes } from 'node:crypto'
import {
  type ReplicaTier,
  replicaTierSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import type { Database } from '../store/db/index.js'
import { cloneBytes } from '../store/inmemory/clone-bytes.js'

const KEY_BYTES = 32
const SALT_BYTES = 16

interface WorkspaceReplicaKey {
  readonly key: Uint8Array<ArrayBuffer>
  readonly salt: Uint8Array<ArrayBuffer>
}

export interface WorkspaceReplicaKeyStoreOptions {
  /** What a workspace with no explicit `workspaces.replicaTier` gets — the
   *  process's resolved `WHITEBOARD_REPLICA_TIER` (replica-env.ts). */
  defaultTier: ReplicaTier
}

export interface WorkspaceReplicaKeyStore {
  /** Mints on first call for a workspace, otherwise answers the same bytes
   *  every time — never a fresh key per call. */
  keyFor(workspaceId: string): Promise<WorkspaceReplicaKey>
  /** The workspace's own override, or null when unset (falls back to the
   *  process default via `effectiveTier`). */
  tierFor(workspaceId: string): Promise<ReplicaTier | null>
  effectiveTier(workspaceId: string): Promise<ReplicaTier>
}

export function createWorkspaceReplicaKeyStore(
  db: Database,
  { defaultTier }: WorkspaceReplicaKeyStoreOptions,
): WorkspaceReplicaKeyStore {
  async function tierFor(workspaceId: string): Promise<ReplicaTier | null> {
    const row = await db
      .selectFrom('workspaces')
      .select('replicaTier')
      .where('id', '=', workspaceId)
      .executeTakeFirst()
    return replicaTierSchema.nullable().parse(row?.replicaTier ?? null)
  }

  return {
    async keyFor(workspaceId) {
      const existing = await db
        .selectFrom('workspaceReplicaKeys')
        .select(['key', 'salt'])
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst()
      if (existing !== undefined) {
        return { key: cloneBytes(existing.key), salt: cloneBytes(existing.salt) }
      }
      // Insert-then-reselect, not insert-then-return-what-was-generated: a
      // concurrent mint may have already won the PK conflict below, and every
      // caller racing keyFor for the same workspace must agree on the SAME
      // bytes — the re-select is what makes that true rather than assumed.
      await db
        .insertInto('workspaceReplicaKeys')
        .values({
          workspaceId,
          key: randomBytes(KEY_BYTES),
          salt: randomBytes(SALT_BYTES),
          createdAt: Date.now(),
        })
        .onConflict((oc) => oc.column('workspaceId').doNothing())
        .execute()
      const row = await db
        .selectFrom('workspaceReplicaKeys')
        .select(['key', 'salt'])
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirstOrThrow()
      return { key: cloneBytes(row.key), salt: cloneBytes(row.salt) }
    },
    tierFor,
    async effectiveTier(workspaceId) {
      return (await tierFor(workspaceId)) ?? defaultTier
    },
  }
}
