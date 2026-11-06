/**
 * A tool's answer names the workspace by its canonical ULID, never by the
 * segment the call addressed it with. The SDK checks the value against the
 * tool's `outputSchema`; this checks the schema still says ULID, since an
 * address-shaped output would pass the SDK and teach a caller the wrong key.
 */
export function assertCanonicalWorkspaceId(tool, workspaceId, addressedAs) {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(workspaceId ?? '') || workspaceId === addressedAs) {
    throw new Error(`${tool} answered a workspace id that is not canonical: ${workspaceId}`)
  }
}
