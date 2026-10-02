import { describe, expect, it } from 'vitest'
import { connectDocumentTools } from './_test-document-tools-client.js'
import { TOOL_PROFILES } from './tool-profiles.js'

// What a host acts on is the EFFECTIVE value: the MCP annotation schema reads
// an absent `destructiveHint` on a tool that is not read-only as TRUE, and the
// SDK fills no defaults. A test asserting `.not.toBe(true)` passes on
// `undefined`, which is exactly the tool a host then prompts for.
const effectiveDestructive = (profile: Readonly<Record<string, boolean>>): boolean =>
  profile.readOnlyHint === true ? false : (profile.destructiveHint ?? true)

// The tools whose worst op loses something. Both-sided with the table: each
// must exist and be non-read-only, and every other write must say `false`.
const DESTRUCTIVE_TOOLS: readonly string[] = [
  // node.remove / edge.remove in a batch.
  'wb_canvas_edit',
  // document.delete in a batch — the ONLY way to delete a document.
  'wb_workspace_edit',
  // `subtree` deletes the documents created since the version (the tree
  // delete evacuates them, so it is recoverable, but it is a delete), and an
  // in-place restore overwrites the current content with the saved state.
  'wb_version_restore',
]

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
    expect(effectiveDestructive(profile)).toBe(false)
  })

  // The other side of that distinction, and the one the CRUD retirement put
  // weight on: `wb_workspace_edit` is now the ONLY way to delete a document,
  // so a host that skips the prompt on it skips it on every delete there is.
  it('declares wb_workspace_edit destructive, since a batch may carry document.delete', () => {
    expect(TOOL_PROFILES.wb_workspace_edit.profile.destructiveHint).toBe(true)
  })

  it('names a destructive tool only if it is registered and writes', () => {
    for (const name of DESTRUCTIVE_TOOLS) {
      const entry = TOOL_PROFILES[name]
      expect(entry, `${name} has no profile`).toBeDefined()
      expect(entry?.profile.readOnlyHint, name).not.toBe(true)
    }
  })

  it('states destructiveHint for every write, destructive only for the named tools', () => {
    const writes = Object.entries(TOOL_PROFILES).filter(([, { profile }]) => !profile.readOnlyHint)
    expect(writes.length).toBeGreaterThan(5)
    for (const [name, { profile }] of writes) {
      expect(typeof profile.destructiveHint, `${name} leaves destructiveHint to the default`).toBe(
        'boolean',
      )
      expect(effectiveDestructive(profile), name).toBe(DESTRUCTIVE_TOOLS.includes(name))
    }
  })

  // C6 / C7 as the client receives them: read off the real `tools/list`,
  // because the annotation is injected at registration and a profile table
  // that looks right can still announce something else.
  it('announces every write with a stated destructiveHint, true only for the named tools', async () => {
    const { tools } = await connectDocumentTools()
    const writes = tools.filter((tool) => tool.annotations?.readOnlyHint !== true)
    expect(writes.length).toBeGreaterThan(5)
    for (const tool of writes) {
      expect(typeof tool.annotations?.destructiveHint, `${tool.name}: destructiveHint`).toBe(
        'boolean',
      )
      expect(tool.annotations?.destructiveHint, tool.name).toBe(
        DESTRUCTIVE_TOOLS.includes(tool.name),
      )
    }
    // Both-sided: a name on the list that is not a listed write is a stale entry.
    expect(writes.map((tool) => tool.name)).toEqual(expect.arrayContaining([...DESTRUCTIVE_TOOLS]))
  })
})
