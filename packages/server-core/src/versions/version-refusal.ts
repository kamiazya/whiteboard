import {
  REFUSAL_CODE_TOO_MANY_VERSIONS,
  TooManyVersions,
  VERSION_REFUSAL_CODES,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/**
 * The codes a keeper refuses a version SAVE with — one per bound the save
 * would break. Declared beside the `VersionHistory` seam, the lowest package
 * both the daemon that raises it and the client contract that parses it can
 * import, so the spelling lives in one place.
 */
export const versionRefusalCodeSchema = z.enum(VERSION_REFUSAL_CODES)
export type VersionRefusalCode = z.infer<typeof versionRefusalCodeSchema>

/**
 * A manual save refused because the document already keeps `limit` manual
 * versions, the most one document keeps — or a restore's merge point refused
 * past the restore-point ceiling of the same size. Nothing was written.
 * Ordinary automatic checkpoints are not refused: retention retires the
 * oldest of those.
 */
export class TooManyVersionsError extends Error {
  readonly code: VersionRefusalCode = REFUSAL_CODE_TOO_MANY_VERSIONS
  readonly status = 413

  constructor(public readonly limit: number) {
    super(TooManyVersions(limit))
    this.name = 'TooManyVersionsError'
  }
}
