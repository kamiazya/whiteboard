// Reading the browser's local-network permission WITHOUT triggering its
// prompt, so the connect flow can explain itself before the prompt appears
// and can offer a recovery path once the answer is already 'denied'.
//
// This matters because a denied answer is sticky: Local Network Access gates
// the request on a permission rather than on a preflight the server could
// satisfy, and a browser that has been told no stops asking. A fetch to the
// daemon then fails indistinguishably from no daemon being there at all.
// https://wicg.github.io/local-network-access/

// 'unknown' is not a browser state — it means the question could not be asked
// (no Permissions API, or an engine that does not recognize the feature), so
// callers must fall back to behavior that does not depend on the answer.
export type LocalNetworkPermissionState = 'granted' | 'prompt' | 'denied' | 'unknown'

// The daemon listens on 127.0.0.1, which the spec scopes to the narrower
// 'loopback-network' feature. 'local-network-access' is the coarse name
// Chromium shipped before the spec split it, kept as a fallback for browsers
// that prompt but predate the split.
const PERMISSION_NAMES = ['loopback-network', 'local-network-access'] as const

export async function queryLocalNetworkPermission(
  permissions: Permissions | undefined,
): Promise<LocalNetworkPermissionState> {
  if (!permissions?.query) return 'unknown'

  for (const name of PERMISSION_NAMES) {
    try {
      // The name is not in the lib.dom PermissionName union yet, so the cast
      // is what lets us ask a question the type definitions predate.
      const status = await permissions.query({ name } as unknown as PermissionDescriptor)
      return status.state
    } catch (error) {
      // An unrecognized descriptor is the only rejection worth retrying under
      // the other name. Anything else (notably a permissions-policy
      // NotAllowedError) is the site's own configuration talking, not the
      // user's answer, and must not be reported as a denial the user could
      // undo in browser settings.
      if (!(error instanceof TypeError)) return 'unknown'
    }
  }

  return 'unknown'
}
