import { z } from 'zod'
import { classifyPagesOrigin } from './lib/pages-origin-policy.js'

// Validates that a URL string is a bare origin: scheme + host + optional port, no path/query/hash/credentials.
// Downstream CORS, OAuth, and Cloudflare config all require a strict origin, not an arbitrary URL.
// Exported so other cross-boundary contracts (e.g. daemon-connection-payload.ts) reuse the same
// origin-validation rules instead of redefining them.
export const bareOriginSchema = z
  .string()
  .url()
  .refine(
    (v) => {
      try {
        const url = new URL(v)
        return url.origin === v && !url.hostname.includes('*')
      } catch {
        return false
      }
    },
    {
      message:
        'must be a bare origin (scheme + host + optional port, no path, query, hash, credentials, or wildcards)',
    },
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

// Thrown only for known-safe, hand-authored, user-facing copy — never built by
// interpolating the rejected origin. resolveProviderStateFromRaw callers rely
// on this type to distinguish trusted policy copy from Zod/unknown errors,
// which must keep their generic non-reflective message instead.
export class RuntimeConfigPolicyError extends Error {}

const GENERIC_HOSTED_ORIGIN_REJECTION =
  'This deployment origin is not supported. Use the production pages.dev origin for hosted deployments.'

// Stricter variant for hosted (Cloudflare Pages) deployments.
// Rejects non-production publicOrigin values so preview deploys and localhost
// cannot accidentally masquerade as the production origin.
export function resolveHostedRuntimeConfig(raw: unknown): RuntimeConfig {
  const config = runtimeConfigSchema.parse(raw)
  if (config.publicOrigin === undefined) {
    return config
  }
  switch (classifyPagesOrigin(config.publicOrigin)) {
    case 'production':
      return config
    case 'custom-domain-deferred':
      // Future support seam: once a canonical custom domain is confirmed
      // (see pages-origin-policy.ts), this branch is where it would move to
      // the 'production' path above instead of throwing.
      throw new RuntimeConfigPolicyError(
        'Custom domains and other Pages projects are not yet supported for hosted deployments. Deploy the hosted app on the production pages.dev origin.',
      )
    default:
      throw new RuntimeConfigPolicyError(GENERIC_HOSTED_ORIGIN_REJECTION)
  }
}
