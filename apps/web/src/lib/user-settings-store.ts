import { tolerantAnswer } from '@kamiazya/whiteboard-daemon-client/api-contracts/tolerant-answer'
import { fitToLength, utf16Max } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { safeGetItem, safeRemoveItem, safeSetItem } from './safe-local-storage.js'

// Namespaced + version-suffixed. Adding a NEW OPTIONAL field does NOT bump the
// key/version: old payloads simply lack it, and a tab still running the older
// build READS a payload carrying it (an unknown key is ignored at every depth,
// see `readSchema`) — the hosted app updates behind a prompt, so tabs of two
// builds routinely share this key. Such a tab's next write drops the field it
// does not know, and nothing else. Bump BOTH this suffix and the `version`
// literal for a BREAKING change (removing a field, changing a type — a new
// value of an existing enum included — or making a field required), AND ship
// a migration in the same increment: bumping alone is the discard this comment
// warns about, just spelled differently.
export const STORAGE_KEY = 'whiteboard:user-settings:v5'

/**
 * The key the previous version wrote, read once and then removed. Older keys
 * (v1 to v3) are not read at all: a browser still holding one starts from
 * the defaults.
 *
 * A new key per version rather than a version discriminator inside one,
 * because that is what makes a concurrently-open OLD tab harmless: it keeps
 * reading and writing its own key, which this build no longer looks at once
 * the current one exists, instead of safeParse-failing on the bumped
 * `version` and overwriting the current payload with its defaults.
 */
export const LEGACY_V4_STORAGE_KEY = 'whiteboard:user-settings:v4'

/**
 * Constrained to http/https because these values are rendered into an `href`
 * and fetched. Anything that can write localStorage — a same-origin script, a
 * browser extension — could otherwise store `javascript:…` and turn a link
 * click into script execution. Rejecting it at the schema protects every
 * consumer, not just the one that renders it today.
 */
const httpUrl = z.string().refine((value) => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}, 'must be an http(s) URL')

// `.strict()` at every level is the enforcement point for "no daemon/cloud
// token in UserSettings" at WRITE: `save` refuses an unknown key (e.g. a
// token-shaped field), so none can be persisted. A READ is tolerant instead
// (`readSchema`): it never surfaces such a key either, and the next write
// leaves it out of storage.
const storageSettingsSchema = z
  .object({
    // Which daemon this browser uses. `local` is gone from the name because
    // it never named this axis: a daemon runs on this machine too, so the
    // word said nothing that distinguished it from the browser keeper.
    daemonBaseUrl: httpUrl.optional(),
    /**
     * Daemon workspaces this browser holds a replica of (ADR-0023), keyed by
     * the daemon workspace id the replica record is stored under. UI-hint
     * state: the replica record itself lives in
     * IndexedDB, and this registry only says when it was last synced and
     * from where — a missing entry means "claim no cache", never "delete
     * the bytes".
     */
    replicas: z
      .record(
        z.string(),
        z
          .object({
            daemonBaseUrl: httpUrl,
            syncedAt: z.string(),
            /**
             * The workspace's other two identity layers, captured at sync
             * time. Offline is exactly when they cannot be resolved against
             * the daemon, and a URL usually carries the SEGMENT while this
             * registry is keyed by the canonical id — without the copy here
             * an offline load could not find the replica its address names.
             */
            segment: z.string().optional(),
            displayName: z.string().optional(),
            /**
             * What the DAEMON is known to hold (a base64 Loro VersionVector,
             * from the pulled bytes alone). Offline edits are exactly the
             * ops beyond this point: the push exports from here, and the
             * "unsent local edits" claim compares against it. Absent on
             * entries from before offline edits existed — treated as
             * "everything might be unsent", which the push resolves by
             * sending a full snapshot once.
             */
            syncedFrontier: z.string().optional(),
            /**
             * Which key generation (`replicaKeyResponseSchema`'s `keyId`) the
             * stored bytes are sealed under. A key the daemon has since
             * replaced opens none of them, and this is how a read tells that
             * from damage. Absent on entries from before rotation existed and
             * on a daemon that predates it — read as "cannot tell", which
             * leaves the old behaviour.
             */
            keyId: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

/**
 * The bound a move's `leftBehind` sentences are held to — here, because this
 * store keeps them in localStorage under a strict schema, and the
 * cross-origin result that carries them in reads the same bound so what
 * arrives always fits what is kept.
 */
export const LEFT_BEHIND_MAX_ENTRIES = 100
export const LEFT_BEHIND_MAX_CHARS = 500

/**
 * A `leftBehind` list fitted to that bound. Clipped rather than refused: a
 * record past the bound fails the strict write, and the whole result —
 * not only the list — would be lost.
 */
export function fitLeftBehind(leftBehind: readonly string[]): string[] {
  return leftBehind
    .slice(0, LEFT_BEHIND_MAX_ENTRIES)
    .map((reason) => fitToLength(reason, LEFT_BEHIND_MAX_CHARS))
}

/**
 * The last whole-workspace promotion's outcome. Persisted (not component
 * state) because the promote UI's result surface is a standing report, never
 * a toast: it must survive navigating away from Settings and a full reload.
 * One slot, overwritten by the next run — promotion is an idempotent merge,
 * so only the latest outcome is actionable.
 */
const promotionResultCommonFields = {
  at: z.string(),
  /**
   * The daemon the move targeted. The result surface renders a stored
   * result as actionable only while connected to this same daemon —
   * without the binding, a result from daemon A (and its reload offer)
   * would keep showing after connecting to daemon B. Optional because
   * records persisted before the field existed lack it; those simply
   * never match and age out on the next move.
   */
  daemonBaseUrl: httpUrl.optional(),
  /** The TARGET daemon workspace the record merged into. */
  workspaceId: z.string(),
}

// A discriminated union rather than one all-optional bag: the v2 shape could
// represent states no run produces (ok with no counts, a failure carrying
// shadowed paths), and every reader paid for that in `??` fallbacks. Each arm
// requires what its writer always writes.
const promotionResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ...promotionResultCommonFields,
      ok: z.literal(true),
      /**
       * The SOURCE browser workspace the record came from. The move
       * disclosure is a claim about one workspace's data, and this browser
       * keeps many — without the source, the banner fires on whichever
       * workspace is active. Optional because records persisted before the
       * field existed lack it; those cannot say which workspace moved, so
       * no disclosure renders.
       */
      sourceWorkspaceId: z.string().optional(),
      /**
       * When the demote pull that follows a successful move cached the
       * daemon workspace's record back into this browser (ADR-0023
       * decision 2). Absent when the pull failed or predates the feature —
       * the report then simply claims no cache.
       */
      replicaSyncedAt: z.string().optional(),
      promotedCount: z.number(),
      shadowedPaths: z.array(z.string()),
      blobsMissing: z.array(z.string()),
      blobsFailed: z.array(z.string()),
      /**
       * Why those uploads failed, one sentence per distinct cause. Absent on
       * records from before the reasons were kept, which can only say how
       * many failed.
       */
      blobFailureReasons: z.array(z.string()).optional(),
      /**
       * Whether the verified demote removed the source browser record
       * (ADR-0023 decision 2). Absent on records from before the feature —
       * those runs kept the copy, so absent reads as false.
       */
      localCopyRemoved: z.boolean().optional(),
      /**
       * What the move could not carry, one sentence each — why the browser
       * copy was kept, for every later visit and not only the session that
       * ran it. Bounded: the store lives in localStorage. Absent on records
       * from before the reasons were kept.
       */
      leftBehind: z
        .array(utf16Max(z.string(), LEFT_BEHIND_MAX_CHARS))
        .max(LEFT_BEHIND_MAX_ENTRIES)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...promotionResultCommonFields,
      ok: z.literal(false),
      reason: z.string(),
    })
    .strict(),
])

export type PromotionResultRecord = z.infer<typeof promotionResultSchema>

const migrationSettingsSchema = z
  .object({
    promotion: promotionResultSchema.optional(),
  })
  .strict()

const capabilitySettingsSchema = z
  .object({
    webMcpEnabled: z.boolean().optional(),
  })
  .strict()

const appearanceSettingsSchema = z
  .object({
    // Which favicon the canvas pages render: a live minimap of the board's
    // content, or the plain logo mark with just the status dot.
    faviconStyle: z.enum(['minimap', 'dot']).optional(),
  })
  .strict()

// What ⋮ → Export… remembers for the picture entries. Absent means the
// defaults the page applies (1x, with the paper background), so a stored value
// only ever records a choice the person made.
const pictureExportSettingsSchema = z
  .object({
    doubleResolution: z.boolean().optional(),
    background: z.boolean().optional(),
  })
  .strict()

export const userSettingsSchema = z
  .object({
    version: z.literal(5),
    storage: storageSettingsSchema,
    migration: migrationSettingsSchema,
    capabilities: capabilitySettingsSchema,
    // Optional (not required) so payloads stored before this section existed
    // keep parsing — see the key/version comment at the top of this file.
    appearance: appearanceSettingsSchema.optional(),
    pictureExport: pictureExportSettingsSchema.optional(),
  })
  .strict()

/**
 * What `load` reads the live payload with: the same schema, deriving only
 * what a reader does about a key it has not heard of. A strict read would let
 * a tab on an older build beside a newer one read the newer payload as
 * unreadable and write defaults back, erasing the daemon URL, the replica
 * registry and the promotion record to lose one field it could not name.
 */
const readSchema = tolerantAnswer(userSettingsSchema)

/**
 * The shape v5 migrates FROM, kept parse-only. Spelled out rather than
 * derived from the live schema, so the live shape is free to move without
 * silently changing what a v4 payload is allowed to contain. It still names the two dismissal stamps — the persistence
 * warning's and the beta banner's — that nothing has read or written since
 * the banners they belonged to went; v5 is the bump that lets them go.
 */
export const legacyV4SettingsSchema = z
  .object({
    version: z.literal(4),
    storage: z
      .object({
        daemonBaseUrl: httpUrl.optional(),
        dismissedPersistenceWarningAt: z.string().optional(),
        dismissedBetaBannerAt: z.string().optional(),
        replicas: z
          .record(
            z.string(),
            z
              .object({
                daemonBaseUrl: httpUrl,
                syncedAt: z.string(),
                segment: z.string().optional(),
                displayName: z.string().optional(),
                syncedFrontier: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    migration: migrationSettingsSchema,
    capabilities: capabilitySettingsSchema,
    appearance: appearanceSettingsSchema.optional(),
  })
  .strict()

export type UserSettings = z.infer<typeof userSettingsSchema>

/**
 * The two dismissal stamps go IN this migration, not through it: nothing
 * reads or writes them, and a field nobody reads does not need to survive
 * the bump.
 */
export function migrateV4(legacy: z.infer<typeof legacyV4SettingsSchema>): UserSettings {
  const {
    dismissedPersistenceWarningAt: _dismissedPersistenceWarningAt,
    dismissedBetaBannerAt: _dismissedBetaBannerAt,
    ...storage
  } = legacy.storage
  return {
    version: 5,
    storage,
    migration: legacy.migration,
    capabilities: legacy.capabilities,
    ...(legacy.appearance === undefined ? {} : { appearance: legacy.appearance }),
  }
}

export function defaultUserSettings(): UserSettings {
  return {
    version: 5,
    storage: {},
    migration: {},
    capabilities: {},
    appearance: {},
  }
}

export interface UserSettingsStore {
  load(): UserSettings
  save(next: UserSettings): void
  update(fn: (current: UserSettings) => UserSettings): void
  reset(): void
}

export function createUserSettingsStore(): UserSettingsStore {
  function readJson(key: string): unknown {
    const raw = safeGetItem(key)
    if (raw === null) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  /**
   * The v4 payload migrates only when the current key is ABSENT, never when
   * it is merely invalid. A corrupt or tampered payload keeps the store's
   * existing invalid-means-defaults contract instead of quietly resurrecting
   * settings the user may have since changed.
   */
  function load(): UserSettings {
    if (safeGetItem(STORAGE_KEY) !== null) {
      const result = readSchema.safeParse(readJson(STORAGE_KEY))
      return result.success ? result.data : defaultUserSettings()
    }
    if (safeGetItem(LEGACY_V4_STORAGE_KEY) === null) return defaultUserSettings()
    const legacy = legacyV4SettingsSchema.safeParse(readJson(LEGACY_V4_STORAGE_KEY))
    if (!legacy.success) return defaultUserSettings()
    const live = migrateV4(legacy.data)
    save(live)
    safeRemoveItem(LEGACY_V4_STORAGE_KEY)
    return live
  }

  function save(next: UserSettings): void {
    const result = userSettingsSchema.safeParse(next)
    if (!result.success) return
    safeSetItem(STORAGE_KEY, JSON.stringify(result.data))
  }

  function update(fn: (current: UserSettings) => UserSettings): void {
    save(fn(load()))
  }

  function reset(): void {
    safeRemoveItem(STORAGE_KEY)
    // The v4 key too, or a reset on a browser that has not migrated yet
    // clears nothing that lasts: load() would find the current key absent,
    // migrate the old one again, and hand back the settings just reset.
    safeRemoveItem(LEGACY_V4_STORAGE_KEY)
  }

  return { load, save, update, reset }
}
