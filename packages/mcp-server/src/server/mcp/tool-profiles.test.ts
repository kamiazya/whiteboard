import { describe, expect, it } from 'vitest'
import { TOOL_PROFILES } from './tool-profiles.js'

// Coverage of TOOL_PROFILES against the registered tool set is asserted in
// tool-naming.test.ts, against ALL_REGISTERED_TOOLS — which the mcp-smoke
// checkpoint compares to a real server's tools/list. A restatement here
// would only be a fourth list to forget to update.
describe('TOOL_PROFILES', () => {
  it('declares wb_document_set as mutating, not read-only or destructive', () => {
    const profile = TOOL_PROFILES.wb_document_set.profile
    expect(profile.readOnlyHint).not.toBe(true)
    expect(profile.destructiveHint).not.toBe(true)
  })
})
