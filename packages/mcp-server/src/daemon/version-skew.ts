/**
 * What differs between the build a daemon record names and the build reading
 * it, as the sentence a person acts on; `null` when they match.
 *
 * Plain inequality rather than a semver comparison: either direction is the
 * same hazard, because two builds over one data directory can each migrate or
 * read a database the other does not understand, and neither can tell which of
 * them is the one to stop.
 */
export function describeDaemonVersionSkew(
  recordedVersion: string,
  runningVersion: string,
): string | null {
  if (recordedVersion === runningVersion) return null
  return (
    `a daemon of version ${recordedVersion} is running on this data directory, ` +
    `but this build is version ${runningVersion}`
  )
}
