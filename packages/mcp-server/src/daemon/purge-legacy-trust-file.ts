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
// their only reference. The lock entry is a directory, hence `recursive`
// below — harmless for the plain JSON file, which `rm` removes either way.
const LEGACY_TRUST_ARTIFACTS = ['trusted-web-origins.json', 'trusted-web-origins.lock']

export interface PurgeLegacyWebOriginTrustFileDeps {
  rm?: typeof rm
}

async function removeBestEffort(path: string, removeFn: typeof rm): Promise<void> {
  try {
    await removeFn(path, { recursive: true })
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
  for (const name of LEGACY_TRUST_ARTIFACTS) {
    await removeBestEffort(join(dataDir, name), removeFn)
  }
}
