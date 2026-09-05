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
  // `workspaces` was here, and its removal is the record of ADR-0019
  // landing: the browser keeper stopped being definitionally
  // single-workspace, both keepers set the flag the same way, and a flag both
  // keepers agree on is not a capability — it gates nothing and the copy
  // built on it promises a difference that is not there.
  // `versions` left the same way: the browser keeps its own manual history
  // now, so both keepers answer true and the flag gates nothing. What the
  // daemon adds on top (automatic checkpoints, thumbnails) is a per-panel
  // fact the page states where it mounts the panel, not a keeper flag.
  // `branches` left the same way, and for the same reason stated twice
  // above: the browser keeps its variations on the workspace record now, so
  // both keepers answer true and the flag gates nothing. WHERE the chip is
  // shown became a per-document fact instead — a markdown document has no
  // record-holding backend and so no branches — which the backend answers
  // through `hasBranches`, in the one place that cannot forget it.
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
  // The browser keeper can commit a merge now, so this flag is on borrowed
  // time: both keepers agree, and a flag both keepers agree on is not a
  // capability — `provider.capability-reach.test.ts` refuses it by name the
  // moment it is flipped, exactly as it refused `branches`.
  //
  // It stays false for one increment because turning it true retires the
  // capability SYSTEM rather than this flag: `WhiteboardCapabilities` has
  // nothing else left in it, and the prop threads through App, both pages,
  // the top bar and `CapabilityTeaser`. That is its own diff to review, and
  // it is what turns the browser's merge on.
  merge: false,
}

export const DAEMON_CAPABILITIES: WhiteboardCapabilities = {
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
