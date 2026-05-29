import { z } from 'zod'
import { isProductionPagesOrigin } from './lib/pages-origin-policy.js'

// Validates that a URL string is a bare origin: scheme + host + optional port, no path/query/hash/credentials.
// Downstream CORS, OAuth, and Cloudflare config all require a strict origin, not an arbitrary URL.
const bareOriginSchema = z.string().url().refine(
  (v) => {
    try {
      const url = new URL(v)
      return url.origin === v && !url.hostname.includes('*')
    } catch {
      return false
    }
  },
  { message: 'must be a bare origin (scheme + host + optional port, no path, query, hash, credentials, or wildcards)' },
)

export const runtimeConfigSchema = z
  .object({
    // Public origin of this deployed app (e.g., 'https://app.example.com').
    // Used to construct absolute URLs for same-origin API calls.
    publicOrigin: bareOriginSchema.optional(),
    // Base URL of the local whiteboard daemon for daemon-pairing mode.
    // e.g. 'http://127.0.0.1:3099'
    daemonBaseUrl: bareOriginSchema.optional(),
  })
  .strict()

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

export function resolveRuntimeConfig(raw: unknown): RuntimeConfig {
  return runtimeConfigSchema.parse(raw)
}

export const EMPTY_RUNTIME_CONFIG: RuntimeConfig = {}

// Stricter variant for hosted (Cloudflare Pages) deployments.
// Rejects non-production publicOrigin values so preview deploys and localhost
// cannot accidentally masquerade as the production origin.
export function resolveHostedRuntimeConfig(raw: unknown): RuntimeConfig {
  const config = runtimeConfigSchema.parse(raw)
  if (config.publicOrigin !== undefined && !isProductionPagesOrigin(config.publicOrigin)) {
    throw new Error('publicOrigin must be the production pages.dev origin for hosted deployments.')
  }
  return config
}
