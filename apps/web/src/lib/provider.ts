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

/**
 * Which keeper answers, and nothing else.
 *
 * There WAS a `WhiteboardCapabilities` map here, and its own history is the
 * argument for deleting it: `workspaces` left when the browser keeper stopped
 * being definitionally single-workspace (ADR-0019), `versions` left when it
 * kept its own history, `branches` left when it kept its own variations on
 * the workspace record, and `merge` leaves now that it commits one. Every one
 * for the same reason — a flag both keepers set the same way gates nothing,
 * and the copy built on it promises a difference that is not there.
 *
 * With the last one gone the map is EMPTY, so the map goes too rather than
 * standing as a shape waiting for a difference to appear. An empty map kept
 * "for later" is the one thing `provider.capability-reach.test.ts` could
 * never have refused, because it had no entries left to judge; if a real
 * difference appears, it comes back carrying that difference.
 *
 * What replaced it is better than a flag, and this is the part worth
 * carrying forward: where the keepers still differ, the difference is a fact
 * about a DOCUMENT or a PANEL rather than about a keeper —
 * `BranchesBackend`'s `hasBranches` (a markdown body has no record-holding
 * backend, so no variations) and `VersionTimelineCapabilities` (the browser's
 * version rows carry no branch to lane by). Each is answered where it is
 * known, by something that cannot forget to mention it.
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
