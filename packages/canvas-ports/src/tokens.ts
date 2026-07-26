import type { BlobStore } from './blob-store.js'
import type { CanvasDocStore } from './canvas-doc-store.js'
import type { PresenceChannel } from './presence.js'
import type { WorkspaceIndex } from './workspace-index.js'

/**
 * A DI token that carries its bound type only at compile time (`__type` is
 * never actually assigned — it exists purely so `Container.get<T>(token)`
 * can infer `T` from the token itself).
 */
export type Token<T> = symbol & { __type?: T }

/**
 * Defines (or re-fetches) a global-registry symbol for a port name.
 * `Symbol.for` guarantees the SAME symbol is returned across separate
 * module instances (e.g. a pnpm-hoisting edge case that double-installs
 * this package), which is required for DI container lookups to work
 * regardless of which copy of canvas-ports registered the binding.
 */
export function defineToken<T>(name: string): Token<T> {
  return Symbol.for(`whiteboard.ports.${name}`) as Token<T>
}

/** Aggregate token registry; each key is exactly its port interface's name. */
export const TOKENS = {
  CanvasDocStore: defineToken<CanvasDocStore>('CanvasDocStore'),
  WorkspaceIndex: defineToken<WorkspaceIndex>('WorkspaceIndex'),
  BlobStore: defineToken<BlobStore>('BlobStore'),
  PresenceChannel: defineToken<PresenceChannel>('PresenceChannel'),
} as const
