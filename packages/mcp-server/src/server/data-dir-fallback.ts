import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { getLogger } from './log.js'

/**
 * `resolveDataDir` falls back to `$TMPDIR/.whiteboard` when the home directory
 * is unwritable (the Codex sandbox). That is not durable storage and it is not
 * where the user's daemon and browser look, so a tool call that "succeeds" into
 * it loses the work without a sign. The fallback is silent by construction
 * (the resolver is pure and runs at module load), so each entry that opens the
 * store says so once it knows the directory it will use.
 */
export function warnWhenDataDirIsTempFallback(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.WHITEBOARD_DATA_DIR) return
  if (dataDir !== resolve(tmpdir(), '.whiteboard')) return
  getLogger('data-dir').warning(
    { dataDir },
    'the home directory is not writable, so data is going to a temp directory that a daemon or browser running elsewhere will not see; set WHITEBOARD_DATA_DIR to a durable directory',
  )
}
