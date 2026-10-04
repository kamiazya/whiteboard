import {
  type RuntimeConfig,
  RuntimeConfigPolicyError,
  resolveHostedRuntimeConfig,
} from '../runtime-config.js'
import { classifyPagesOrigin } from './pages-origin-policy.js'

const GENERIC_INVALID_CONFIG_MESSAGE = 'Runtime configuration is invalid.'

// Only a RuntimeConfigPolicyError carries authored, known-safe, user-facing
// copy. Zod/unknown errors keep the generic message so raw input (query,
// path, credential fragments) is never reflected back to the user.
function toInvalidConfigState(err: unknown): Extract<ProviderState, { kind: 'invalid-config' }> {
  if (err instanceof RuntimeConfigPolicyError) {
    return { kind: 'invalid-config', message: err.message }
  }
  return { kind: 'invalid-config', message: GENERIC_INVALID_CONFIG_MESSAGE }
}

/**
 * Which keeper answers, and nothing else.
 *
 * There is no capability map: a flag both keepers set the same way gates
 * nothing, and the copy built on it promises a difference that is not there.
 * Where the keepers still differ, the difference is a fact about a DOCUMENT
 * rather than about a keeper, answered where it is known by something that
 * cannot forget to mention it. If a real keeper-level difference appears, a
 * map returns carrying that difference.
 */
export type ProviderState =
  | { readonly kind: 'browser' }
  | { readonly kind: 'daemon'; readonly daemonBaseUrl: string }
  | { readonly kind: 'invalid-config'; readonly message: string }

export function resolveProviderState(config: RuntimeConfig): ProviderState {
  if (config.daemonBaseUrl !== undefined) {
    return { kind: 'daemon', daemonBaseUrl: config.daemonBaseUrl }
  }
  return { kind: 'browser' }
}

// Hosted-production variant: rejects non-production publicOrigin values;
// localhost is allowed for local dev. Cloudflare Pages preview browser origins
// (latest.<project>.pages.dev, per-PR branch aliases, hash previews) run in
// browser mode — it is offline and origin-agnostic — but a daemon
// connection is refused there so a preview deploy can never reach a daemon.
export function resolveHostedProviderStateFromRaw(
  raw: unknown,
  browserOrigin?: string,
): ProviderState {
  const isPreviewOrigin =
    browserOrigin !== undefined && classifyPagesOrigin(browserOrigin) === 'preview'
  try {
    const state = resolveProviderState(resolveHostedRuntimeConfig(raw))
    if (isPreviewOrigin && state.kind === 'daemon') {
      return { kind: 'invalid-config', message: GENERIC_INVALID_CONFIG_MESSAGE }
    }
    return state
  } catch (err) {
    return toInvalidConfigState(err)
  }
}
