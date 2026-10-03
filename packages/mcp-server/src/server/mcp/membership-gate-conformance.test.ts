/**
 * ADR-0046 decision 10 holds for the tools that exist, not for the ones the
 * gate's own tests imagine: the gate keys on the `workspaceId` field of a
 * tool's input, so a tool that names its workspace any other way would run
 * ungated and pass every fake-tool test. This runs the REAL tool set through
 * it.
 */
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { InMemoryDocumentIndex, InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { createServer, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import { FakeVersionHistory } from '@kamiazya/whiteboard-server-core/test-utils/fake-version-history'
import { describe, expect, it } from 'vitest'
import type { ResolvedGrant } from '../security/credential-resolver.js'
import { gatedByMembership, runAsMcpCaller } from '../security/mcp-caller.js'
import type { MemberProfileStore } from '../security/member-profile-store.js'
import { liveDocuments } from '../store/live-documents.js'
import { connectDocumentTools } from './_test-document-tools-client.js'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'

// The tools whose input leaves workspaceId optional, in registration order.
// `wb_facet_list` with none answers the deployment's facet registry alone.
const WORKSPACE_OPTIONAL = ['wb_facet_list']

function realTools() {
  return createServer({
    documentStore: new InMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    versions: new FakeVersionHistory(),
    liveDocuments: liveDocuments(),
    facetRegistry: bundledFacetRegistry,
  } as unknown as ServerDeps).tools
}

describe('the membership gate over the registered tools', () => {
  it('sees every registered tool, so the walks below are not vacuous', async () => {
    const names = Object.values(realTools()).map((tool) => tool.name)
    expect([...names].sort()).toEqual([...ALL_REGISTERED_TOOLS].sort())
    const { tools } = await connectDocumentTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([...ALL_REGISTERED_TOOLS].sort())
  })

  // A required field is what the gate selects on; an optional one is a way
  // to skip it. The one deliberate exception is written out here, apart from
  // the gate's own list, so the two have to agree: a tool whose schema leaves
  // the field optional must be one the gate lets through, and no other.
  it('requires workspaceId on every tool except the one that answers without it', async () => {
    const { tools } = await connectDocumentTools()
    const optional = tools
      .filter((tool) => !(tool.inputSchema.required ?? []).includes('workspaceId'))
      .map((tool) => tool.name)
    expect(optional).toEqual(WORKSPACE_OPTIONAL)
    for (const tool of tools.filter((t) => WORKSPACE_OPTIONAL.includes(t.name))) {
      expect(tool.inputSchema.properties).toHaveProperty('workspaceId')
    }
  })

  it('refuses every tool to a caller who is not signed in as a person', async () => {
    const index = { resolveWorkspace: async () => null }
    const gated = gatedByMembership(realTools(), index)
    const grant: ResolvedGrant = { kind: 'external-bearer', scopes: ['mcp:call'] }
    const members = {
      membersOnly: async () => true,
      profileForBinding: async () => null,
    } as unknown as MemberProfileStore
    const entries = Object.values(gated)
    expect(entries.length).toBe(ALL_REGISTERED_TOOLS.length)
    for (const tool of entries) {
      await expect(
        runAsMcpCaller({ grant, members }, () =>
          (tool as { execute(input: unknown): Promise<unknown> }).execute({ workspaceId: 'ws-1' }),
        ),
        tool.name,
      ).rejects.toThrow(/requires_person_session/)
    }
  })

  it('lets through, naming no workspace, exactly the tools whose schema allows it', async () => {
    const gated = gatedByMembership(realTools(), { resolveWorkspace: async () => null })
    const grant: ResolvedGrant = { kind: 'external-bearer', scopes: ['mcp:call'] }
    const members = { membersOnly: async () => true } as unknown as MemberProfileStore
    const passed: string[] = []
    for (const tool of Object.values(gated)) {
      const outcome = await runAsMcpCaller({ grant, members }, () =>
        (tool as { execute(input: unknown): Promise<unknown> }).execute({}),
      ).then(
        () => 'ran',
        (error: Error) => (/workspace_required/.test(error.message) ? 'refused' : 'ran'),
      )
      if (outcome === 'ran') passed.push(tool.name)
    }
    expect(passed).toEqual(WORKSPACE_OPTIONAL)
  })
})
