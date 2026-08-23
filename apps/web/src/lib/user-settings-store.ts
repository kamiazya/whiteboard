import { z } from 'zod'

// Namespaced + version-suffixed. Adding a NEW OPTIONAL field is backward- and
// forward-compatible under `.strict()` (old payloads simply lack it; old tabs
// safeParse-fail on it only transiently), so it does NOT bump the key/version —
// bumping would discard every existing user's stored settings. Bump BOTH this
// suffix and the `version` literal only for a BREAKING change (removing a
// field, changing a type, or making a field required).
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
    preferredProvider: z.enum(['browser', 'daemon']).optional(),
    lastBrowserLocalCanvasId: z.string().optional(),
    // Constrained to http/https because this value is rendered into an `href`
    // (the "Open the local app" escape hatch). Anything that can write
    // localStorage — a same-origin script, a browser extension — could
    // otherwise store `javascript:…` here and turn a link click into script
    // execution. Rejecting it at the schema protects every consumer, not just
    // the one that renders it today.
    localDaemonBaseUrl: z
      .string()
      .refine((value) => {
        try {
          const { protocol } = new URL(value)
          return protocol === 'http:' || protocol === 'https:'
        } catch {
          return false
        }
      }, 'must be an http(s) URL')
      .optional(),
    // The (workspaceId, path) last reached via a #wb= pairing, alongside
    // localDaemonBaseUrl above — together they let a later hosted-app load
    // offer a one-click reconnect to the same daemon and canvas instead of
    // just the daemon's root. path is meaningless without workspaceId, but
    // this is UI-hint state (not an access boundary), so it is not enforced
    // by a cross-field refine the way daemonConnectionPayloadSchema does.
    lastConnectedWorkspaceId: z.string().optional(),
    lastConnectedPath: z.string().optional(),
    // Every daemon baseUrl a probe has actually confirmed, most recent
    // first (see daemon-discovery.ts's MRU helper). Same http(s)-only
    // constraint as localDaemonBaseUrl above and for the same reason:
    // these values are rendered into hrefs and fetched.
    knownDaemonBaseUrls: z
      .array(
        z.string().refine((value) => {
          try {
            const { protocol } = new URL(value)
            return protocol === 'http:' || protocol === 'https:'
          } catch {
            return false
          }
        }, 'must be an http(s) URL'),
      )
      // The writer keeps this MRU-capped (daemon-discovery's helper), and
      // every stored entry is re-probed on the next check — an oversized
      // tampered array must not turn discovery into an unbounded fan-out.
      .max(5, 'must contain at most 5 daemon URLs')
      .optional(),
    // Daemons the user explicitly disconnected from. Discovery skips these
    // even inside its scanned port range, which is what makes a disconnect
    // outlive the page — without it the default-port daemon reappears on the
    // next load and the action reads as a no-op. Same http(s) constraint and
    // same cap as the known list, for the same reasons.
    dismissedDaemonBaseUrls: z
      .array(
        z.string().refine((value) => {
          try {
            const { protocol } = new URL(value)
            return protocol === 'http:' || protocol === 'https:'
          } catch {
            return false
          }
        }, 'must be an http(s) URL'),
      )
      .max(5, 'must contain at most 5 daemon URLs')
      .optional(),
    dismissedPersistenceWarningAt: z.string().optional(),
    dismissedBetaBannerAt: z.string().optional(),
    dismissedDaemonCtaAt: z.string().optional(),
    dismissedDaemonCtaInstanceId: z.string().optional(),
  })
  .strict()

const migrationSettingsSchema = z
  .object({
    browserLocalToDaemon: z
      .object({
        lastExportedAt: z.string().optional(),
        lastImportedAt: z.string().optional(),
        lastImportedDocumentId: z.string().optional(),
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

const appearanceSettingsSchema = z
  .object({
    // Which favicon the canvas pages render: a live minimap of the board's
    // content, or the plain logo mark with just the status dot.
    faviconStyle: z.enum(['minimap', 'dot']).optional(),
  })
  .strict()

const userSettingsSchema = z
  .object({
    version: z.literal(1),
    storage: storageSettingsSchema,
    migration: migrationSettingsSchema,
    capabilities: capabilitySettingsSchema,
    // Optional (not required) so payloads stored before this section existed
    // keep parsing — see the key/version comment at the top of this file.
    appearance: appearanceSettingsSchema.optional(),
  })
  .strict()

export type UserSettings = z.infer<typeof userSettingsSchema>

export function defaultUserSettings(): UserSettings {
  return {
    version: 1,
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
