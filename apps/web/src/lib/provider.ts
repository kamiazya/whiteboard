import {
  type RuntimeConfig,
  RuntimeConfigPolicyError,
  resolveHostedRuntimeConfig,
  resolveRuntimeConfig,
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

// Static, in-process, per-provider-kind capability map — NOT a cross-process
// or persisted contract (no negotiation, no wire payload), so this stays a
// plain type + const map rather than a Zod schema. Deliberate, not an oversight.
export type WhiteboardCapabilities = {
  readonly workspaces: boolean
  readonly versions: boolean
  readonly branches: boolean
  readonly merge: boolean
}

export type ProviderState =
  | { readonly kind: 'browser'; readonly capabilities: WhiteboardCapabilities }
  | {
      readonly kind: 'daemon'
      readonly daemonBaseUrl: string
      readonly capabilities: WhiteboardCapabilities
    }
  | { readonly kind: 'invalid-config'; readonly message: string }

export const BROWSER_CAPABILITIES: WhiteboardCapabilities = {
  workspaces: false,
  versions: false,
  branches: false,
  merge: false,
}

export const DAEMON_CAPABILITIES: WhiteboardCapabilities = {
  workspaces: true,
  versions: true,
  branches: true,
  merge: true,
}

export function resolveProviderState(config: RuntimeConfig): ProviderState {
  if (config.daemonBaseUrl !== undefined) {
    return {
      kind: 'daemon',
      daemonBaseUrl: config.daemonBaseUrl,
      capabilities: DAEMON_CAPABILITIES,
    }
  }
  return {
    kind: 'browser',
    capabilities: BROWSER_CAPABILITIES,
  }
}

export function resolveProviderStateFromRaw(raw: unknown): ProviderState {
  try {
    return resolveProviderState(resolveRuntimeConfig(raw))
  } catch {
    // Return a safe message without reflecting the raw input to avoid leaking
    // credential, query, or path fragments in user-facing error output.
    return { kind: 'invalid-config', message: GENERIC_INVALID_CONFIG_MESSAGE }
  }
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
