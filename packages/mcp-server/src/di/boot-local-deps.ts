import { bootSelfHostDeps } from './boot-self-host-deps.js'

/**
 * `bootSelfHostDeps` for the roots whose caller can already see every workspace
 * on this machine: the stdio entry and the local daemon. A refusal for an
 * unknown workspace may then name the ones that exist, so an agent that
 * guessed an address learns the right one. Server mode boots through
 * `bootSelfHostDeps` directly, because its refusal is uniform on purpose.
 */
export function bootLocalDeps(dataDir: string): ReturnType<typeof bootSelfHostDeps> {
  return bootSelfHostDeps(dataDir, { nameKnownWorkspaces: true })
}
