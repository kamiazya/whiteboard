import { describe, expect, it } from 'vitest'
import { ALL_REGISTERED_TOOLS } from '../mcp/mcp-smoke-coverage.js'
import { TOOL_PROFILES } from '../mcp/tool-profiles.js'
import { MCP_TOOL_SCOPES } from './mcp-tool-scopes.js'

describe('MCP_TOOL_SCOPES', () => {
  // A registered tool with no entry is refused on server mode's /mcp, and an
  // entry for a tool that is gone is a scope decision nobody reads.
  it('names exactly the registered tools', () => {
    expect(Object.keys(MCP_TOOL_SCOPES).sort()).toEqual([...ALL_REGISTERED_TOOLS].sort())
  })

  it('never lets a read scope alone reach a tool announced as a write', () => {
    for (const name of ALL_REGISTERED_TOOLS) {
      const readOnly = TOOL_PROFILES[name]?.profile.readOnlyHint === true
      const scopes = MCP_TOOL_SCOPES[name] ?? []
      expect(scopes.length, name).toBeGreaterThan(0)
      for (const scope of scopes) {
        expect(scope.endsWith(':write'), `${name} needs ${scope}`).toBe(!readOnly)
      }
    }
  })
})
