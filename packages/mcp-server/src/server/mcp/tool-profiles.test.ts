import { describe, expect, it } from 'vitest'
import { TOOL_PROFILES } from './tool-profiles.js'

// Coverage of TOOL_PROFILES against the registered tool set is asserted in
// tool-naming.test.ts, against ALL_REGISTERED_TOOLS — which the mcp-smoke
// checkpoint compares to a real server's tools/list. A restatement here
// would only be a fourth list to forget to update.
describe('TOOL_PROFILES', () => {
  // The distinction a client acts on: `destructiveHint` is what makes a host
  // ask before running the call. A body replacement loses nothing that was
  // not being replaced, so it must not claim it.
  it('declares wb_body_edit as mutating, not read-only or destructive', () => {
    const profile = TOOL_PROFILES.wb_body_edit.profile
    expect(profile.readOnlyHint).not.toBe(true)
    expect(profile.destructiveHint).not.toBe(true)
  })

  // The other side of that distinction, and the one the CRUD retirement put
  // weight on: `wb_workspace_edit` is now the ONLY way to delete a document,
  // so a host that skips the prompt on it skips it on every delete there is.
  it('declares wb_workspace_edit destructive, since a batch may carry document.delete', () => {
    expect(TOOL_PROFILES.wb_workspace_edit.profile.destructiveHint).toBe(true)
  })
})
