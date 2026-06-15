import { resolveHostedRuntimeConfig, resolveRuntimeConfig, type RuntimeConfig } from '../runtime-config.js'
import { classifyPagesOrigin } from './pages-origin-policy.js'

export type ProviderKind = 'browser-local' | 'local-daemon'

export type WhiteboardCapabilities = {
  readonly canvasReadWrite: boolean
  readonly migrationExport: boolean
  readonly migrationImport: boolean
  readonly workspaces: boolean
  readonly versions: boolean
}

export type ProviderState =
  | { readonly kind: 'browser-local'; readonly capabilities: WhiteboardCapabilities }
  | { readonly kind: 'local-daemon'; readonly daemonBaseUrl: string; readonly capabilities: WhiteboardCapabilities }
  | { readonly kind: 'invalid-config'; readonly message: string }

const BROWSER_LOCAL_CAPABILITIES: WhiteboardCapabilities = {
  canvasReadWrite: true,
  migrationExport: true,
  migrationImport: false,
  workspaces: false,
  versions: false,
}

const LOCAL_DAEMON_CAPABILITIES: WhiteboardCapabilities = {
  canvasReadWrite: true,
  migrationExport: false,
  migrationImport: true,
  workspaces: true,
  versions: true,
}

export function resolveProviderState(config: RuntimeConfig): ProviderState {
  if (config.daemonBaseUrl !== undefined) {
    return {
      kind: 'local-daemon',
      daemonBaseUrl: config.daemonBaseUrl,
      capabilities: LOCAL_DAEMON_CAPABILITIES,
    }
  }
  return {
    kind: 'browser-local',
    capabilities: BROWSER_LOCAL_CAPABILITIES,
  }
}

export function resolveProviderStateFromRaw(raw: unknown): ProviderState {
  try {
    return resolveProviderState(resolveRuntimeConfig(raw))
  } catch {
    // Return a safe message without reflecting the raw input to avoid leaking
    // credential, query, or path fragments in user-facing error output.
    return { kind: 'invalid-config', message: 'Runtime configuration is invalid.' }
  }
}

// Hosted-production variant: rejects non-production publicOrigin values and
// Cloudflare Pages preview browser origins so that preview deploys cannot
// silently enter browser-local mode. localhost is allowed for local dev.
export function resolveHostedProviderStateFromRaw(raw: unknown, browserOrigin?: string): ProviderState {
  if (browserOrigin !== undefined && classifyPagesOrigin(browserOrigin) === 'preview') {
    return { kind: 'invalid-config', message: 'Runtime configuration is invalid.' }
  }
  try {
    return resolveProviderState(resolveHostedRuntimeConfig(raw))
  } catch {
    return { kind: 'invalid-config', message: 'Runtime configuration is invalid.' }
  }
}
