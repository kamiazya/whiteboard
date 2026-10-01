/**
 * Whether `/` belongs to another user than this process, which is what makes
 * "a data dir another user owns" reachable without a second account.
 *
 * Probed from the filesystem rather than inferred from `getuid() === 0`: a
 * container can map root to this user, and Windows has no uid to compare.
 * Resolved once at module load because `it.skipIf` needs it at collection.
 */
import { statSync } from 'node:fs'

const uid = process.getuid?.()

export const ROOT_IS_SOMEONE_ELSES: boolean = uid !== undefined && statSync('/').uid !== uid
