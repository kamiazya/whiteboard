import { z } from 'zod'

// Namespaced + version-suffixed. Adding a NEW OPTIONAL field is backward- and
// forward-compatible under `.strict()` (old payloads simply lack it; old tabs
// safeParse-fail on it only transiently), so it does NOT bump the key/version —
// bumping would discard every existing user's stored settings. Bump BOTH this
// suffix and the `version` literal only for a BREAKING change (removing a
// field, changing a type, or making a field required), AND ship a migration
// in the same increment: bumping alone is the discard this comment warns
// about, just spelled differently.
export const STORAGE_KEY = 'whiteboard:user-settings:v2'

/**
 * The key v2 migrates FROM, read once and then removed.
 *
 * Two keys rather than a version discriminator inside one, because that is
 * what makes a concurrently-open OLD tab harmless: it keeps reading and
 * writing v1, which this build no longer looks at once v2 exists, instead of
 * safeParse-failing on the bumped `version` and overwriting v2 with its
 * defaults.
 */
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
  })
  .strict()

/**
 * The last whole-workspace promotion's outcome. Persisted (not component
 * state) because the promote UI's result surface is a standing report, never
 * a toast: it must survive navigating away from Settings and a full reload.
 * One slot, overwritten by the next run — promotion is an idempotent merge,
 * so only the latest outcome is actionable.
 */
const promotionResultSchema = z
  .object({
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
    ok: z.boolean(),
    promotedCount: z.number().optional(),
    shadowedPaths: z.array(z.string()).optional(),
    blobsMissing: z.array(z.string()).optional(),
    blobsFailed: z.array(z.string()).optional(),
    reason: z.string().optional(),
  })
  .strict()

export type PromotionResultRecord = z.infer<typeof promotionResultSchema>

const migrationSettingsSchema = z
  .object({
    browserToDaemon: z
      .object({
        lastExportedAt: z.string().optional(),
        lastImportedAt: z.string().optional(),
        lastImportedDocumentId: z.string().optional(),
      })
      .strict()
      .optional(),
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
    version: z.literal(2),
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
      // `.strict()` here for the same reason v2 has it: the migration must not
      // become the hole a token-shaped key travels through.
      .strict(),
    migration: migrationSettingsSchema,
    capabilities: capabilitySettingsSchema,
    appearance: appearanceSettingsSchema.optional(),
  })
  .strict()

export type UserSettings = z.infer<typeof userSettingsSchema>

function migrateV1(legacy: z.infer<typeof legacyV1SettingsSchema>): UserSettings {
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

export function defaultUserSettings(): UserSettings {
  return {
    version: 2,
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
   * Migrates only when the v2 key is ABSENT, never when it is merely invalid.
   * A corrupt or tampered v2 payload keeps the store's existing
   * invalid-means-defaults contract instead of quietly resurrecting settings
   * the user may have since changed.
   */
  function migrateFromV1(): UserSettings | null {
    const result = legacyV1SettingsSchema.safeParse(readJson(LEGACY_V1_STORAGE_KEY))
    if (!result.success) return null
    const migrated = migrateV1(result.data)
    save(migrated)
    safeRemoveItem(LEGACY_V1_STORAGE_KEY)
    return migrated
  }

  function load(): UserSettings {
    if (safeGetItem(STORAGE_KEY) === null) return migrateFromV1() ?? defaultUserSettings()
    const result = userSettingsSchema.safeParse(readJson(STORAGE_KEY))
    return result.success ? result.data : defaultUserSettings()
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
    // Both keys, or a reset on a browser that has not migrated yet clears
    // nothing that lasts: load() would find v2 absent, migrate v1 again, and
    // hand back the settings the user just reset.
    safeRemoveItem(LEGACY_V1_STORAGE_KEY)
  }

  return { load, save, update, reset }
}
