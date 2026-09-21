/**
 * The read plane's per-workspace content key (ADR-0042 decisions 1/3/5,
 * ADR-0043 decision 3): a random 32-byte AES key plus a 16-byte HKDF salt,
 * minted lazily on first read. `rotateKey` REPLACES the pair outright
 * (Reading A of the 2026-09-21 addendum) — every document key derived from
 * the old pair stops opening anything the moment rotation lands, which is
 * the whole point: a suspected-compromised key must deny the holder of the
 * OLD pair, not merely start issuing a new one alongside it. The per-
 * document `epoch` (daemon-client's `deriveDocumentKey`) plays no part in
 * rotation and is not bumped here — a per-document number cannot express a
 * per-workspace key replacement, and re-deriving under the SAME workspace
 * pair at a higher epoch would still be openable by whoever held that pair.
 * See the ADR-0042 addendum for what this denies and what it does not (a
 * session already holding the key in memory keeps reading until it next
 * asks, and every existing browser replica becomes unreadable and must be
 * re-pulled).
 *
 * The browser derives each document's own key from this one via
 * daemon-client's `deriveDocumentKey`, folding in that document's own epoch
 * (which lives beside its ciphertext, not here).
 *
 * The key is a daemon-held secret AT REST, not a secret from the daemon
 * itself — this store never claims otherwise. The data directory is
 * owner-only (see `secret-file-mode.ts`'s sibling posture for the JSON
 * secrets), and a filesystem backup of `whiteboard.db` already carries every
 * document's plaintext, so this row adds no new secret-surface class beyond
 * what a backup of the database already exposes.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  type ReplicaTier,
  replicaTierSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import type { Database } from '../store/db/index.js'
import { cloneBytes } from '../store/inmemory/clone-bytes.js'

const KEY_BYTES = 32
const SALT_BYTES = 16

export interface WorkspaceReplicaKey {
  readonly key: Uint8Array<ArrayBuffer>
  readonly salt: Uint8Array<ArrayBuffer>
  /** A pure function of (key, salt) — never stored, so it cannot drift from
   *  the bytes it names. Lets a reader (the route, and eventually the
   *  browser's cached replica) tell "the workspace key changed" from "the
   *  bytes I already have" without comparing raw key material. */
  readonly keyId: string
}

/** The one builder of a `WorkspaceReplicaKey`, so the id can never be derived
 *  from a different pair than the one it travels with. The id is
 *  `sha256("wb-workspace-key-id-v1" ‖ key ‖ salt)`, truncated to 16 bytes and
 *  base64url-encoded (22 chars, no padding) — the same encoding
 *  `workspaceKeySalt` already uses in the wire contract. Truncate the BYTES,
 *  not the string: base64url's 22nd character also encodes part of byte 16. */
function withKeyId(
  key: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
): WorkspaceReplicaKey {
  const digest = createHash('sha256')
    .update('wb-workspace-key-id-v1')
    .update(key)
    .update(salt)
    .digest()
  return { key, salt, keyId: digest.subarray(0, 16).toString('base64url') }
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
  /** Sets or clears (`null`) the workspace's own override. This is a
   *  security-posture write, so callers gate it at `runtime:admin`
   *  (route-scope-registry.ts) rather than the membership-scoped
   *  `workspace:write` the rest of a workspace's fields sit behind — see
   *  routes/replica-key.ts. Answers whether a `workspaces` row existed to
   *  update: `workspaces` rows are minted lazily off document writes
   *  (upsert-workspace.ts), so a workspace nobody has written to yet has
   *  none, and a bare UPDATE against it would otherwise read as success. */
  setTier(workspaceId: string, tier: ReplicaTier | null): Promise<boolean>
  /** Replaces the workspace's key+salt outright with a fresh random pair —
   *  see this module's header for why REPLACE rather than an epoch bump.
   *  One upsert statement: an insert for a workspace with no row yet, or an
   *  overwrite of the existing row otherwise, so a concurrent `keyFor` sees
   *  either wholly the old pair or wholly the new one, never a mix. Gate
   *  callers at `runtime:admin` (routes/replica-key.ts), the same bar as
   *  `setTier` — rotation is at least as consequential as a tier change. */
  rotateKey(workspaceId: string): Promise<WorkspaceReplicaKey>
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
        return withKeyId(cloneBytes(existing.key), cloneBytes(existing.salt))
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
      return withKeyId(cloneBytes(row.key), cloneBytes(row.salt))
    },
    tierFor,
    async effectiveTier(workspaceId) {
      return (await tierFor(workspaceId)) ?? defaultTier
    },
    async setTier(workspaceId, tier) {
      // The column is untyped text (migration 0029 added no CHECK), so a
      // bad value would otherwise only surface as a throw from `tierFor` on
      // the NEXT read, far from the write that caused it.
      const validated = replicaTierSchema.nullable().parse(tier)
      const result = await db
        .updateTable('workspaces')
        .set({ replicaTier: validated })
        .where('id', '=', workspaceId)
        .executeTakeFirst()
      return Number(result.numUpdatedRows ?? 0) > 0
    },
    async rotateKey(workspaceId) {
      const key = randomBytes(KEY_BYTES)
      const salt = randomBytes(SALT_BYTES)
      const createdAt = Date.now()
      // ONE upsert: a concurrent keyFor reading mid-statement sees SQLite's
      // row-level atomicity, so it observes either the pre-rotation row or
      // this one in full, never a torn mix of old key + new salt (or vice
      // versa) — which would derive a document key that opens nothing, and
      // fail silently rather than loudly.
      await db
        .insertInto('workspaceReplicaKeys')
        .values({ workspaceId, key, salt, createdAt })
        .onConflict((oc) => oc.column('workspaceId').doUpdateSet({ key, salt, createdAt }))
        .execute()
      return withKeyId(cloneBytes(key), cloneBytes(salt))
    },
  }
}
