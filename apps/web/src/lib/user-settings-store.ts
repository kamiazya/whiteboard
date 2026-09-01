import { z } from 'zod'

// Namespaced + version-suffixed. Adding a NEW OPTIONAL field is backward- and
// forward-compatible under `.strict()` (old payloads simply lack it; old tabs
// safeParse-fail on it only transiently), so it does NOT bump the key/version —
// bumping would discard every existing user's stored settings. Bump BOTH this
// suffix and the `version` literal only for a BREAKING change (removing a
// field, changing a type, or making a field required), AND ship a migration
// in the same increment: bumping alone is the discard this comment warns
// about, just spelled differently.
export const STORAGE_KEY = 'whiteboard:user-settings:v3'

/**
 * The keys older versions wrote, each read once and then removed.
 *
 * A new key per version rather than a version discriminator inside one,
 * because that is what makes a concurrently-open OLD tab harmless: it keeps
 * reading and writing its own key, which this build no longer looks at once
 * the current one exists, instead of safeParse-failing on the bumped
 * `version` and overwriting the current payload with its defaults.
 */
export const LEGACY_V2_STORAGE_KEY = 'whiteboard:user-settings:v2'
export const LEGACY_V1_STORAGE_KEY = 'whiteboard:user-settings:v1'

// localStorage access itself can throw (SecurityError when the browser blocks
// storage via privacy settings or embedded contexts). The store's contract is
// "never throws" — treat a throwing storage like an empty one.
function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Contract: never throws; an unwritable storage degrades to in-memory-only.
  }
}

function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Contract: never throws.
  }
}

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
// token in UserSettings": an unknown key (e.g. a token-shaped field) makes
// safeParse fail, and callers fall back to defaults rather than persisting it.
const storageSettingsSchema = z
  .object({
    // Which daemon this browser uses. `local` is gone from the name because
    // it never named this axis: a daemon runs on this machine too, so the
    // word said nothing that distinguished it from the browser keeper.
    daemonBaseUrl: httpUrl.optional(),
    // The (workspaceId, path) last reached via a #wb= pairing, alongside
    // daemonBaseUrl above — together they let a later hosted-app load
    // offer a one-click reconnect to the same daemon and canvas instead of
    // just the daemon's root. path is meaningless without workspaceId, but
    // this is UI-hint state (not an access boundary), so it is not enforced
    // by a cross-field refine the way daemonConnectionPayloadSchema does.
    lastConnectedWorkspaceId: z.string().optional(),
    lastConnectedPath: z.string().optional(),
    // Every daemon baseUrl a probe has actually confirmed, most recent
    // first (see daemon-discovery.ts's MRU helper).
    knownDaemonBaseUrls: z
      .array(httpUrl)
      // The writer keeps this MRU-capped (daemon-discovery's helper), and
      // every stored entry is re-probed on the next check — an oversized
      // tampered array must not turn discovery into an unbounded fan-out.
      .max(5, 'must contain at most 5 daemon URLs')
      .optional(),
    // Daemons the user explicitly disconnected from. Discovery skips these
    // even inside its scanned port range, which is what makes a disconnect
    // outlive the page — without it the default-port daemon reappears on the
    // next load and the action reads as a no-op. Same cap as the known list,
    // for the same reason.
    dismissedDaemonBaseUrls: z
      .array(httpUrl)
      .max(5, 'must contain at most 5 daemon URLs')
      .optional(),
    dismissedPersistenceWarningAt: z.string().optional(),
    dismissedBetaBannerAt: z.string().optional(),
    dismissedDaemonCtaAt: z.string().optional(),
    dismissedDaemonCtaInstanceId: z.string().optional(),
    /**
     * Daemon workspaces this browser holds a replica of (ADR-0023), keyed by
     * the daemon workspace id the replica record is stored under. UI-hint
     * state like lastConnected*: the replica record itself lives in
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
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

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
// shadowed paths), and every reader paid for that in `??` fallbacks. The
// v2->v3 migration normalizes legacy partial records once, so each arm can
// require what its writer always writes.
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
    webMcpMaxTier: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .optional(),
  })
  .strict()

const appearanceSettingsSchema = z
  .object({
    // Which favicon the canvas pages render: a live minimap of the board's
    // content, or the plain logo mark with just the status dot.
    faviconStyle: z.enum(['minimap', 'dot']).optional(),
  })
  .strict()

const userSettingsSchema = z
  .object({
    version: z.literal(3),
    storage: storageSettingsSchema,
    migration: migrationSettingsSchema,
    capabilities: capabilitySettingsSchema,
    // Optional (not required) so payloads stored before this section existed
    // keep parsing — see the key/version comment at the top of this file.
    appearance: appearanceSettingsSchema.optional(),
  })
  .strict()

/**
 * The shape v2 migrates FROM, kept parse-only.
 *
 * It spells the retired keeper words on purpose, for the same reason a
 * database migration names the columns as they stood at its point in the log:
 * this schema's whole job is to read a payload that was written under those
 * names. Correcting them here would make it parse nothing.
 *
 * Not derived from `storageSettingsSchema` by `.extend()`/`.omit()`, because
 * the two shapes are only coincidentally similar — v2 is free to move without
 * silently changing what a v1 payload is allowed to contain.
 */
/**
 * The all-optional promotion shape v1 and v2 stored, kept parse-only. The
 * live schema is a discriminated union; this one's job is to read whatever
 * partial record an old payload holds so the v3 migration can normalize it.
 */
const legacyPromotionResultSchema = z
  .object({
    at: z.string(),
    daemonBaseUrl: httpUrl.optional(),
    workspaceId: z.string(),
    sourceWorkspaceId: z.string().optional(),
    replicaSyncedAt: z.string().optional(),
    ok: z.boolean(),
    promotedCount: z.number().optional(),
    shadowedPaths: z.array(z.string()).optional(),
    blobsMissing: z.array(z.string()).optional(),
    blobsFailed: z.array(z.string()).optional(),
    reason: z.string().optional(),
  })
  .strict()

const legacyMigrationSettingsSchema = z
  .object({
    // Written by the retired per-document import panel and read by nothing
    // since; v2 kept it parse-only because dropping the key under `.strict()`
    // would have discarded the whole payload. The v3 migration is the
    // version bump that lets it finally be dropped.
    browserToDaemon: z
      .object({
        lastExportedAt: z.string().optional(),
        lastImportedAt: z.string().optional(),
        lastImportedDocumentId: z.string().optional(),
      })
      .strict()
      .optional(),
    promotion: legacyPromotionResultSchema.optional(),
  })
  .strict()

const legacyV1SettingsSchema = z
  .object({
    version: z.literal(1),
    storage: z
      .object({
        // Dead on arrival: nothing in the app ever read or wrote either of
        // these. They are dropped rather than renamed — a field nobody reads
        // does not need a better name.
        preferredProvider: z.enum(['browser-local', 'local-daemon']).optional(),
        lastBrowserCanvasId: z.string().optional(),
        localDaemonBaseUrl: httpUrl.optional(),
        lastConnectedWorkspaceId: z.string().optional(),
        lastConnectedPath: z.string().optional(),
        knownDaemonBaseUrls: z.array(httpUrl).max(5).optional(),
        dismissedDaemonBaseUrls: z.array(httpUrl).max(5).optional(),
        dismissedPersistenceWarningAt: z.string().optional(),
        dismissedBetaBannerAt: z.string().optional(),
        dismissedDaemonCtaAt: z.string().optional(),
        dismissedDaemonCtaInstanceId: z.string().optional(),
      })
      // `.strict()` here for the same reason the live schema has it: the
      // migration must not become the hole a token-shaped key travels
      // through.
      .strict(),
    migration: legacyMigrationSettingsSchema,
    capabilities: capabilitySettingsSchema,
    appearance: appearanceSettingsSchema.optional(),
  })
  .strict()

/**
 * The shape v3 migrates FROM. Its storage half is spelled out rather than
 * reusing `storageSettingsSchema`, for the same reason v1's is: the live
 * schema is free to move without silently changing what a v2 payload is
 * allowed to contain — a required field added to the live shape must not
 * start failing this parse and discarding migrating users' payloads.
 */
const legacyV2SettingsSchema = z
  .object({
    version: z.literal(2),
    storage: z
      .object({
        daemonBaseUrl: httpUrl.optional(),
        lastConnectedWorkspaceId: z.string().optional(),
        lastConnectedPath: z.string().optional(),
        knownDaemonBaseUrls: z.array(httpUrl).max(5).optional(),
        dismissedDaemonBaseUrls: z.array(httpUrl).max(5).optional(),
        dismissedPersistenceWarningAt: z.string().optional(),
        dismissedBetaBannerAt: z.string().optional(),
        dismissedDaemonCtaAt: z.string().optional(),
        dismissedDaemonCtaInstanceId: z.string().optional(),
        replicas: z
          .record(
            z.string(),
            z
              .object({
                daemonBaseUrl: httpUrl,
                syncedAt: z.string(),
                segment: z.string().optional(),
                displayName: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    migration: legacyMigrationSettingsSchema,
    capabilities: capabilitySettingsSchema,
    appearance: appearanceSettingsSchema.optional(),
  })
  .strict()

export type UserSettings = z.infer<typeof userSettingsSchema>

function migrateV1(
  legacy: z.infer<typeof legacyV1SettingsSchema>,
): z.infer<typeof legacyV2SettingsSchema> {
  const { preferredProvider, lastBrowserCanvasId, localDaemonBaseUrl, ...carried } = legacy.storage
  return {
    version: 2,
    storage: {
      ...carried,
      // Spread conditionally rather than assigning `undefined`: the value is
      // JSON.stringify-ed straight back out, and an explicit `undefined` and
      // an absent key are the same there but not to `toHaveProperty`.
      ...(localDaemonBaseUrl === undefined ? {} : { daemonBaseUrl: localDaemonBaseUrl }),
    },
    migration: legacy.migration,
    capabilities: legacy.capabilities,
    ...(legacy.appearance === undefined ? {} : { appearance: legacy.appearance }),
  }
}

/**
 * The one-time home of the `??` fallbacks the union retired from readers:
 * an old ok record may lack the counts its writer now always supplies, and
 * an old failure may lack its reason.
 */
function normalizeLegacyPromotion(
  legacy: z.infer<typeof legacyPromotionResultSchema>,
): PromotionResultRecord {
  const common = {
    at: legacy.at,
    ...(legacy.daemonBaseUrl === undefined ? {} : { daemonBaseUrl: legacy.daemonBaseUrl }),
    workspaceId: legacy.workspaceId,
  }
  if (!legacy.ok) {
    return { ...common, ok: false, reason: legacy.reason ?? 'unknown error' }
  }
  return {
    ...common,
    ok: true,
    ...(legacy.sourceWorkspaceId === undefined
      ? {}
      : { sourceWorkspaceId: legacy.sourceWorkspaceId }),
    ...(legacy.replicaSyncedAt === undefined ? {} : { replicaSyncedAt: legacy.replicaSyncedAt }),
    promotedCount: legacy.promotedCount ?? 0,
    shadowedPaths: legacy.shadowedPaths ?? [],
    blobsMissing: legacy.blobsMissing ?? [],
    blobsFailed: legacy.blobsFailed ?? [],
  }
}

function migrateV2(legacy: z.infer<typeof legacyV2SettingsSchema>): UserSettings {
  const { promotion } = legacy.migration
  return {
    version: 3,
    storage: legacy.storage,
    // browserToDaemon goes IN the migration (dropped), not through it: a
    // field nobody reads does not need to survive the bump.
    migration: promotion === undefined ? {} : { promotion: normalizeLegacyPromotion(promotion) },
    capabilities: legacy.capabilities,
    ...(legacy.appearance === undefined ? {} : { appearance: legacy.appearance }),
  }
}

export function defaultUserSettings(): UserSettings {
  return {
    version: 3,
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

  function migrateFromV2(): UserSettings | null {
    const result = legacyV2SettingsSchema.safeParse(readJson(LEGACY_V2_STORAGE_KEY))
    if (!result.success) return null
    const migrated = migrateV2(result.data)
    save(migrated)
    safeRemoveItem(LEGACY_V2_STORAGE_KEY)
    return migrated
  }

  function migrateFromV1(): UserSettings | null {
    const result = legacyV1SettingsSchema.safeParse(readJson(LEGACY_V1_STORAGE_KEY))
    if (!result.success) return null
    const migrated = migrateV2(migrateV1(result.data))
    save(migrated)
    safeRemoveItem(LEGACY_V1_STORAGE_KEY)
    return migrated
  }

  /**
   * Each step migrates only when every NEWER key is ABSENT, never when one
   * is merely invalid. A corrupt or tampered payload keeps the store's
   * existing invalid-means-defaults contract instead of quietly resurrecting
   * settings the user may have since changed.
   */
  function load(): UserSettings {
    if (safeGetItem(STORAGE_KEY) !== null) {
      const result = userSettingsSchema.safeParse(readJson(STORAGE_KEY))
      return result.success ? result.data : defaultUserSettings()
    }
    if (safeGetItem(LEGACY_V2_STORAGE_KEY) !== null) {
      return migrateFromV2() ?? defaultUserSettings()
    }
    return migrateFromV1() ?? defaultUserSettings()
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
    // Every key, or a reset on a browser that has not migrated yet clears
    // nothing that lasts: load() would find the current key absent, migrate
    // an old one again, and hand back the settings the user just reset.
    safeRemoveItem(LEGACY_V2_STORAGE_KEY)
    safeRemoveItem(LEGACY_V1_STORAGE_KEY)
  }

  return { load, save, update, reset }
}
