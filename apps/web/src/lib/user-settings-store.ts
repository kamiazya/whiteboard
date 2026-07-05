import { z } from 'zod'

// Namespaced + version-suffixed so a future schema bump can migrate without
// colliding with the V1 key still read by older tabs during a rollout.
// Because the schemas below are `.strict()`, ANY field addition or change MUST
// bump both this key suffix and the `version` literal: an older tab would
// safeParse-fail on a newer payload, fall back to defaults, and then clobber
// the newer fields if both versions shared one key.
export const STORAGE_KEY = 'whiteboard:user-settings:v1'

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

// `.strict()` at every level is the enforcement point for "no daemon/cloud
// token in UserSettings": an unknown key (e.g. a token-shaped field) makes
// safeParse fail, and callers fall back to defaults rather than persisting it.
const storageSettingsSchema = z
  .object({
    preferredProvider: z.enum(['browser-local', 'local-daemon']).optional(),
    lastBrowserLocalCanvasId: z.string().optional(),
    localDaemonBaseUrl: z.string().optional(),
    dismissedPersistenceWarningAt: z.string().optional(),
  })
  .strict()

const migrationSettingsSchema = z
  .object({
    browserLocalToDaemon: z
      .object({
        lastExportedAt: z.string().optional(),
        lastImportedAt: z.string().optional(),
        lastImportedCanvasId: z.string().optional(),
      })
      .strict()
      .optional(),
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

const userSettingsSchema = z
  .object({
    version: z.literal(1),
    storage: storageSettingsSchema,
    migration: migrationSettingsSchema,
    capabilities: capabilitySettingsSchema,
  })
  .strict()

export type UserSettings = z.infer<typeof userSettingsSchema>

export function defaultUserSettings(): UserSettings {
  return {
    version: 1,
    storage: {},
    migration: {},
    capabilities: {},
  }
}

export interface UserSettingsStore {
  load(): UserSettings
  save(next: UserSettings): void
  update(fn: (current: UserSettings) => UserSettings): void
  reset(): void
}

export function createUserSettingsStore(): UserSettingsStore {
  function load(): UserSettings {
    const raw = safeGetItem(STORAGE_KEY)
    if (raw === null) return defaultUserSettings()

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      return defaultUserSettings()
    }

    const result = userSettingsSchema.safeParse(parsedJson)
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
  }

  return { load, save, update, reset }
}
