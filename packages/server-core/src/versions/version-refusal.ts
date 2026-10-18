import { z } from 'zod'

/**
 * The codes a keeper refuses a version SAVE with — one per bound the save
 * would break. Declared beside the `VersionHistory` seam, the lowest package
 * both the daemon that raises it and the client contract that parses it can
 * import, so the spelling lives in one place.
 */
export const versionRefusalCodeSchema = z.enum(['too_many_versions'])
export type VersionRefusalCode = z.infer<typeof versionRefusalCodeSchema>

/**
 * A manual save refused because the document already keeps `limit` manual
 * versions, the most one document keeps. Nothing was written. Automatic
 * checkpoints are not refused: retention retires the oldest of those.
 */
export class TooManyVersionsError extends Error {
  readonly code: VersionRefusalCode = 'too_many_versions'
  readonly status = 413

  constructor(public readonly limit: number) {
    super(
      `This document already keeps ${limit} saved versions, the most one document keeps; no further version can be saved for it`,
    )
    this.name = 'TooManyVersionsError'
  }
}
