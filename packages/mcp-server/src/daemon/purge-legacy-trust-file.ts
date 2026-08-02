// Cleans up the on-disk artifact left behind by the now-removed silent-
// reconnect surface (enrolled P-256 public keys + hashed legacy secrets).
// Keeping it around after the feature is deleted would leave stale
// credentials on disk indefinitely, and a manual operator cleanup step is
// one most operators will never run — so this runs unconditionally, best-
// effort, at every daemon startup instead.
//
// Best-effort by contract: a missing file is the common case and silent; any
// OTHER removal failure (permissions, a locked handle, …) is logged but must
// never fail startup — this file's presence or absence was never load-
// bearing for daemon operation, only for a feature that no longer exists.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getLogger } from '../server/log.js'

// The filename/dirname literals formerly lived in web-origin-trust-store.ts,
// which owned the reconnect trust store. That module is gone; this is now
// their only reference.
const WEB_ORIGIN_TRUST_FILENAME = 'trusted-web-origins.json'
const WEB_ORIGIN_TRUST_LOCK_DIRNAME = 'trusted-web-origins.lock'

export interface PurgeLegacyWebOriginTrustFileDeps {
  rm?: typeof rm
}

async function removeBestEffort(
  path: string,
  removeFn: typeof rm,
  options: Parameters<typeof rm>[1],
): Promise<void> {
  try {
    await removeFn(path, options)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return
    getLogger('daemon-startup').warning(
      { path, err: err as Error },
      'failed to remove stale reconnect trust artifact',
    )
  }
}

export async function purgeLegacyWebOriginTrustFile(
  dataDir: string,
  deps: PurgeLegacyWebOriginTrustFileDeps = {},
): Promise<void> {
  const removeFn = deps.rm ?? rm
  await removeBestEffort(join(dataDir, WEB_ORIGIN_TRUST_FILENAME), removeFn, undefined)
  await removeBestEffort(join(dataDir, WEB_ORIGIN_TRUST_LOCK_DIRNAME), removeFn, {
    recursive: true,
  })
}
