import {
  type RuntimeConfig,
  bareOriginSchema,
  runtimeConfigSchema,
} from '@kamiazya/whiteboard-mcp/api-client'
import { classifyPagesOrigin } from './lib/pages-origin-policy.js'

// The wire contract is owned by the daemon package's published /api-client
// subpath (single source of truth across mcp-server and apps/web) — this
// module re-exports it rather than redefining it, and adds only the
// deployment-target policy that decides which parsed configs are acceptable
// here (hosted-origin allowlisting).
export { bareOriginSchema, runtimeConfigSchema }
export type { RuntimeConfig }

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
